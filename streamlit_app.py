from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import streamlit as st
import streamlit.components.v1 as components


DATA_DIR = Path(__file__).resolve().parent
STARTER_PATH = DATA_DIR / "steak_time_starter.json"
CALIBRATION_PATH = DATA_DIR / "reverse_sear_calibration.json"

CONVECTION_FACTOR = 0.9
DEFAULT_REVERSE_SEAR_SECONDS_PER_SIDE = 90
DEFAULT_MASS_PER_IN_OZ = 9.5
DEFAULT_BASELINE_START_F = 41.0
DEFAULT_BAKE_ACTUAL_RATIO = 0.9
DEFAULT_CONVECTION_ACTUAL_RATIO = 0.945


@dataclass
class Inputs:
    cut_id: str
    doneness_id: str
    thickness_in: float
    weight_oz: Optional[float]
    oven_temp_f: int
    oven_mode: str
    start_temp_assumption: str
    method_id: str = "reverse_sear"


@dataclass
class ThermalCoefficients:
    k_fast: float
    k_slow: float
    baseline_start_temp_f: float
    baseline_oven_actual_f: float


def round_range(low: float, high: float) -> Tuple[int, int]:
    low_rounded = max(1, round(low))
    high_rounded = max(low_rounded, round(high))
    return int(low_rounded), int(high_rounded)


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def weighted_average(rows: List[Dict[str, Any]], weight_key: str, value_key: str) -> float:
    weighted_sum = 0.0
    total_weight = 0.0
    for row in rows:
        w = float(row[weight_key])
        weighted_sum += w * float(row[value_key])
        total_weight += w
    if total_weight <= 0:
        return 0.0
    return weighted_sum / total_weight


def build_cut_mass_context(starter_data: Dict[str, Any]) -> Dict[str, Any]:
    buckets: Dict[str, List[float]] = {}
    for cut in starter_data["cuts"]:
        w = cut.get("typical_weight_oz")
        t = cut.get("typical_thickness_in")
        if isinstance(w, (int, float)) and isinstance(t, (int, float)) and t > 0:
            mass_per_in = float(w) / float(t)
            buckets.setdefault(cut["cook_class"], []).append(mass_per_in)

    by_cut_class: Dict[str, float] = {}
    all_values: List[float] = []
    for cut_class, values in buckets.items():
        avg = sum(values) / len(values)
        by_cut_class[cut_class] = avg
        all_values.extend(values)

    if all_values:
        global_mass_per_in = sum(all_values) / len(all_values)
    else:
        global_mass_per_in = DEFAULT_MASS_PER_IN_OZ

    return {
        "by_cut_class": by_cut_class,
        "global_mass_per_in_oz": global_mass_per_in,
    }


def estimate_selection_weight_oz(
    starter_data: Dict[str, Any], cut_id: str, thickness_in: float
) -> float:
    cut = next((c for c in starter_data["cuts"] if c["cut_id"] == cut_id), None)
    if not cut:
        return max(2.0, DEFAULT_MASS_PER_IN_OZ * thickness_in)

    typical_weight = cut.get("typical_weight_oz")
    typical_thickness = cut.get("typical_thickness_in")
    if (
        isinstance(typical_weight, (int, float))
        and isinstance(typical_thickness, (int, float))
        and typical_thickness > 0
    ):
        mass_per_in = float(typical_weight) / float(typical_thickness)
        return max(2.0, mass_per_in * thickness_in)

    context = build_cut_mass_context(starter_data)
    mass_per_in = context["by_cut_class"].get(
        cut["cook_class"], context["global_mass_per_in_oz"]
    )
    return max(2.0, float(mass_per_in) * thickness_in)


def resolve_input_weight_oz(starter_data: Dict[str, Any], inputs: Inputs) -> float:
    if isinstance(inputs.weight_oz, (int, float)) and inputs.weight_oz > 0:
        return float(inputs.weight_oz)
    return estimate_selection_weight_oz(starter_data, inputs.cut_id, inputs.thickness_in)


def build_calibration_observations(
    starter_data: Dict[str, Any], calibration_data: Dict[str, Any]
) -> List[Dict[str, Any]]:
    observations: List[Dict[str, Any]] = []
    fallback_context = build_cut_mass_context(starter_data)

    for profile in calibration_data["profiles"]:
        inferred_125_low = profile.get("time_to_125_low")
        inferred_125_high = profile.get("time_to_125_high")
        if inferred_125_low is None:
            inferred_125_low = profile["time_to_120_low"] + calibration_data[
                "default_minutes_per_degree"
            ]["low"] * 5
        if inferred_125_high is None:
            inferred_125_high = profile["time_to_120_high"] + calibration_data[
                "default_minutes_per_degree"
            ]["high"] * 5

        for cut_class in profile["cut_classes"]:
            if (
                isinstance(profile.get("typical_weight_oz"), (int, float))
                and profile["thickness_in"] > 0
            ):
                mass_per_in = float(profile["typical_weight_oz"]) / float(
                    profile["thickness_in"]
                )
            else:
                mass_per_in = fallback_context["by_cut_class"].get(
                    cut_class, fallback_context["global_mass_per_in_oz"]
                )

            estimated_weight_oz = max(2.0, mass_per_in * float(profile["thickness_in"]))
            confidence_weight = 1 + math.sqrt(max(1.0, float(profile["sample_count"]))) * 0.2

            observations.append(
                {
                    "source": "calibration",
                    "method_id": "reverse_sear",
                    "oven_mode": profile["oven_mode"],
                    "cut_class": cut_class,
                    "thickness_in": float(profile["thickness_in"]),
                    "oven_temp_f": float(calibration_data["base_oven_temp_f"]),
                    "pull_temp_f": 120.0,
                    "estimated_weight_oz": estimated_weight_oz,
                    "low_minutes": float(profile["time_to_120_low"]),
                    "high_minutes": float(profile["time_to_120_high"]),
                    "confidence_weight": confidence_weight,
                }
            )
            observations.append(
                {
                    "source": "calibration",
                    "method_id": "reverse_sear",
                    "oven_mode": profile["oven_mode"],
                    "cut_class": cut_class,
                    "thickness_in": float(profile["thickness_in"]),
                    "oven_temp_f": float(calibration_data["base_oven_temp_f"]),
                    "pull_temp_f": 125.0,
                    "estimated_weight_oz": estimated_weight_oz,
                    "low_minutes": float(inferred_125_low),
                    "high_minutes": float(inferred_125_high),
                    "confidence_weight": confidence_weight,
                }
            )

    return observations


def calculate_distance(obs: Dict[str, Any], target: Dict[str, Any], prefer_source: str) -> float:
    thickness_term = abs(obs["thickness_in"] - target["thickness_in"]) / 0.45
    temp_term = abs(obs["oven_temp_f"] - target["oven_temp_f"]) / 70
    pull_term = abs(obs["pull_temp_f"] - target["pull_temp_f"]) / 8
    mass_term = abs(obs["estimated_weight_oz"] - target["estimated_weight_oz"]) / 9

    category_penalty = 0.0
    if obs["method_id"] != target["method_id"]:
        category_penalty += 2.3
    if obs["oven_mode"] != target["oven_mode"]:
        category_penalty += 1.1
    if obs["cut_class"] != target["cut_class"]:
        category_penalty += 0.9
    if prefer_source and obs["source"] != prefer_source:
        category_penalty += 0.4

    squared = (
        thickness_term * thickness_term
        + temp_term * temp_term
        + pull_term * pull_term
        + mass_term * mass_term
        + category_penalty * category_penalty
    )
    return math.sqrt(squared)


def build_weight(
    distance: float,
    obs: Dict[str, Any],
    target: Dict[str, Any],
    prefer_source: str,
    source_boost: Dict[str, float],
) -> float:
    weight = obs["confidence_weight"] * math.exp(-0.5 * distance * distance)
    if weight < 1e-6:
        weight = obs["confidence_weight"] / ((distance + 0.35) * (distance + 0.35))

    if obs["method_id"] == target["method_id"]:
        weight *= 1.35
    if obs["oven_mode"] == target["oven_mode"]:
        weight *= 1.15
    if obs["cut_class"] == target["cut_class"]:
        weight *= 1.12
    if source_boost.get(obs["source"]):
        weight *= source_boost[obs["source"]]
    if prefer_source and obs["source"] == prefer_source:
        weight *= 1.15

    return weight


def apply_pull_adjustment(low: float, high: float, target: Dict[str, Any], weighted_pull: float) -> Tuple[float, float]:
    delta_pull = target["pull_temp_f"] - weighted_pull
    if abs(delta_pull) < 1:
        return low, high

    thickness_factor = 0.82 + target["thickness_in"] * 0.2
    slope_low, slope_high = 0.45, 0.65
    return (
        low + delta_pull * slope_low * thickness_factor,
        high + delta_pull * slope_high * thickness_factor,
    )


def apply_mass_adjustment(low: float, high: float, target: Dict[str, Any], weighted_mass: float) -> Tuple[float, float]:
    if weighted_mass <= 0 or target["estimated_weight_oz"] <= 0:
        return low, high
    factor = pow(target["estimated_weight_oz"] / weighted_mass, 0.34)
    factor = clamp(factor, 0.72, 1.4)
    if abs(factor - 1) < 0.03:
        return low, high
    return low * factor, high * factor


def apply_temp_extrapolation(
    low: float, high: float, target: Dict[str, Any], weighted_oven: float, observed_temps: List[float]
) -> Tuple[float, float]:
    if not observed_temps:
        return low, high
    min_temp, max_temp = min(observed_temps), max(observed_temps)
    outside = target["oven_temp_f"] < min_temp or target["oven_temp_f"] > max_temp
    far = abs(target["oven_temp_f"] - weighted_oven) > 45
    if not outside and not far:
        return low, high

    base_drive = max(10, weighted_oven - target["pull_temp_f"])
    target_drive = max(10, target["oven_temp_f"] - target["pull_temp_f"])
    factor = base_drive / target_drive
    factor = clamp(factor, 0.45, 2.6)
    return low * factor, high * factor


def apply_uncertainty_widening(
    low: float, high: float, mean_distance: float, std_low: float, std_high: float
) -> Tuple[float, float]:
    spread = math.sqrt(max(0.0, (std_low * std_low + std_high * std_high) / 2))
    widen_minutes = max(1.0, mean_distance * 1.6 + spread * 0.35)
    widened_low = max(1.0, low - widen_minutes * 0.2)
    widened_high = max(widened_low + 1, high + widen_minutes * 0.8)
    return widened_low, widened_high


def predict_with_hybrid_regression(
    observations: List[Dict[str, Any]], target: Dict[str, Any]
) -> Tuple[int, int]:
    if not observations:
        return 1, 2

    rows: List[Dict[str, Any]] = []
    for obs in observations:
        dist = calculate_distance(obs, target, prefer_source="calibration")
        weight = build_weight(
            dist,
            obs,
            target,
            prefer_source="calibration",
            source_boost={"calibration": 1.35},
        )
        rows.append({"observation": obs, "distance": dist, "weight": weight})

    rows.sort(key=lambda x: x["distance"])
    rows = rows[: min(12, len(rows))]

    for row in rows:
        row["low_minutes"] = row["observation"]["low_minutes"]
        row["high_minutes"] = row["observation"]["high_minutes"]
        row["pull_temp_f"] = row["observation"]["pull_temp_f"]
        row["oven_temp_f"] = row["observation"]["oven_temp_f"]
        row["estimated_weight_oz"] = row["observation"]["estimated_weight_oz"]

    mean_low = weighted_average(rows, "weight", "low_minutes")
    mean_high = weighted_average(rows, "weight", "high_minutes")
    weighted_pull = weighted_average(rows, "weight", "pull_temp_f")
    weighted_oven = weighted_average(rows, "weight", "oven_temp_f")
    weighted_mass = weighted_average(rows, "weight", "estimated_weight_oz")
    mean_distance = weighted_average(rows, "weight", "distance")

    std_low = math.sqrt(
        max(
            0.0,
            weighted_average(
                [
                    {
                        "weight": row["weight"],
                        "sq_delta": (row["low_minutes"] - mean_low) ** 2,
                    }
                    for row in rows
                ],
                "weight",
                "sq_delta",
            ),
        )
    )
    std_high = math.sqrt(
        max(
            0.0,
            weighted_average(
                [
                    {
                        "weight": row["weight"],
                        "sq_delta": (row["high_minutes"] - mean_high) ** 2,
                    }
                    for row in rows
                ],
                "weight",
                "sq_delta",
            ),
        )
    )

    method_rows = [row for row in rows if row["observation"]["method_id"] == target["method_id"]]
    observed_method_temps = [row["observation"]["oven_temp_f"] for row in method_rows]

    low, high = apply_pull_adjustment(mean_low, mean_high, target, weighted_pull)
    low, high = apply_mass_adjustment(low, high, target, weighted_mass)
    low, high = apply_temp_extrapolation(
        low,
        high,
        target,
        weighted_average(method_rows, "weight", "oven_temp_f") if method_rows else weighted_oven,
        observed_method_temps if observed_method_temps else [row["observation"]["oven_temp_f"] for row in rows],
    )
    low, high = apply_uncertainty_widening(low, high, mean_distance, std_low, std_high)

    return round_range(low, high)


def derive_thermal_coefficients(profile: Dict[str, Any], calibration_data: Dict[str, Any]) -> Optional[ThermalCoefficients]:
    has_125 = profile.get("time_to_125_low") is not None and profile.get("time_to_125_high") is not None
    target_temp = 125.0 if has_125 else 120.0
    fast_time = float(profile["time_to_125_low"] if has_125 else profile["time_to_120_low"])
    slow_time = float(profile["time_to_125_high"] if has_125 else profile["time_to_120_high"])
    if fast_time <= 0 or slow_time <= 0:
        return None

    baseline_start = float(profile.get("start_temp_f", DEFAULT_BASELINE_START_F))
    default_ratio = (
        DEFAULT_CONVECTION_ACTUAL_RATIO if profile["oven_mode"] == "convection" else DEFAULT_BAKE_ACTUAL_RATIO
    )
    baseline_oven_actual = float(
        profile.get("oven_actual_f", calibration_data["base_oven_temp_f"] * default_ratio)
    )
    if baseline_oven_actual <= target_temp + 8 or baseline_oven_actual <= baseline_start + 8:
        return None

    numerator = math.log((baseline_oven_actual - baseline_start) / (baseline_oven_actual - target_temp))
    if not math.isfinite(numerator) or numerator <= 0:
        return None

    faster = min(fast_time, slow_time)
    slower = max(fast_time, slow_time)
    k_fast = numerator / faster
    k_slow = numerator / slower
    if not (math.isfinite(k_fast) and math.isfinite(k_slow) and k_slow > 0):
        return None

    return ThermalCoefficients(
        k_fast=max(k_fast, k_slow),
        k_slow=min(k_fast, k_slow),
        baseline_start_temp_f=baseline_start,
        baseline_oven_actual_f=baseline_oven_actual,
    )


def interpolate_thermal_coefficients(
    profiles: List[Dict[str, Any]], thickness_in: float, calibration_data: Dict[str, Any]
) -> Optional[ThermalCoefficients]:
    points: List[Tuple[float, ThermalCoefficients]] = []
    for profile in profiles:
        coeff = derive_thermal_coefficients(profile, calibration_data)
        if coeff is not None:
            points.append((float(profile["thickness_in"]), coeff))
    points.sort(key=lambda x: x[0])
    if not points:
        return None

    exact = next((c for t, c in points if t == thickness_in), None)
    if exact:
        return exact

    lower = None
    upper = None
    for thickness, coeff in points:
        if thickness < thickness_in:
            lower = (thickness, coeff)
        elif thickness > thickness_in and upper is None:
            upper = (thickness, coeff)
            break

    if lower and upper:
        ratio = (thickness_in - lower[0]) / (upper[0] - lower[0])
        return ThermalCoefficients(
            k_fast=lower[1].k_fast + (upper[1].k_fast - lower[1].k_fast) * ratio,
            k_slow=lower[1].k_slow + (upper[1].k_slow - lower[1].k_slow) * ratio,
            baseline_start_temp_f=lower[1].baseline_start_temp_f
            + (upper[1].baseline_start_temp_f - lower[1].baseline_start_temp_f) * ratio,
            baseline_oven_actual_f=lower[1].baseline_oven_actual_f
            + (upper[1].baseline_oven_actual_f - lower[1].baseline_oven_actual_f) * ratio,
        )

    nearest = min(points, key=lambda x: abs(x[0] - thickness_in))
    return nearest[1]


def convert_thermal_for_mode(coeff: ThermalCoefficients, source_mode: str, selected_mode: str) -> ThermalCoefficients:
    target_mode = "convection" if selected_mode == "convection" else "bake"
    if source_mode == target_mode:
        return coeff
    if source_mode == "bake" and target_mode == "convection":
        return ThermalCoefficients(
            k_fast=coeff.k_fast / CONVECTION_FACTOR,
            k_slow=coeff.k_slow / CONVECTION_FACTOR,
            baseline_start_temp_f=coeff.baseline_start_temp_f,
            baseline_oven_actual_f=coeff.baseline_oven_actual_f * 1.02,
        )
    return ThermalCoefficients(
        k_fast=coeff.k_fast * CONVECTION_FACTOR,
        k_slow=coeff.k_slow * CONVECTION_FACTOR,
        baseline_start_temp_f=coeff.baseline_start_temp_f,
        baseline_oven_actual_f=coeff.baseline_oven_actual_f * 0.98,
    )


def predict_range_from_thermal(
    coeff: ThermalCoefficients, calibration_data: Dict[str, Any], inputs: Inputs, pull_temp_f: float
) -> Optional[Tuple[float, float]]:
    oven_actual_ratio = coeff.baseline_oven_actual_f / float(calibration_data["base_oven_temp_f"])
    estimated_oven_actual = max(pull_temp_f + 8, float(inputs.oven_temp_f) * oven_actual_ratio)
    baseline_start = coeff.baseline_start_temp_f
    if inputs.start_temp_assumption == "tempered":
        selected_start_temp = min(pull_temp_f - 8, baseline_start + 18)
    else:
        selected_start_temp = baseline_start
    if selected_start_temp >= pull_temp_f - 5:
        return None

    log_term = math.log((estimated_oven_actual - selected_start_temp) / (estimated_oven_actual - pull_temp_f))
    if not math.isfinite(log_term) or log_term <= 0:
        return None

    low = log_term / coeff.k_fast
    high = log_term / coeff.k_slow
    if not (math.isfinite(low) and math.isfinite(high) and low > 0 and high > 0):
        return None

    delta_from_base = abs(float(inputs.oven_temp_f) - float(calibration_data["base_oven_temp_f"]))
    if delta_from_base > 60:
        widen = 1 + (delta_from_base - 60) / 260
        low *= 1 + (widen - 1) * 0.35
        high *= widen

    return max(1.0, low), max(low, high)


def apply_specialized_weight_adjustment(
    specialized_low: float,
    specialized_high: float,
    starter_data: Dict[str, Any],
    inputs: Inputs,
) -> Tuple[float, float]:
    if not isinstance(inputs.weight_oz, (int, float)) or inputs.weight_oz <= 0:
        return specialized_low, specialized_high
    baseline_weight = estimate_selection_weight_oz(starter_data, inputs.cut_id, inputs.thickness_in)
    if baseline_weight <= 0:
        return specialized_low, specialized_high

    factor = pow(float(inputs.weight_oz) / baseline_weight, 0.34)
    factor = clamp(factor, 0.72, 1.4)
    if abs(factor - 1) < 0.03:
        return specialized_low, specialized_high
    return specialized_low * factor, specialized_high * factor


def specialized_reverse_sear_range(
    starter_data: Dict[str, Any],
    calibration_data: Dict[str, Any],
    inputs: Inputs,
    pull_temp_f: float,
    cut_class: str,
) -> Optional[Tuple[float, float]]:
    if inputs.method_id != "reverse_sear":
        return None
    if inputs.oven_mode == "broil":
        return None

    points_for_cut = [p for p in calibration_data["profiles"] if cut_class in p["cut_classes"]]
    if not points_for_cut:
        return None

    wanted_mode = "convection" if inputs.oven_mode == "convection" else "bake"
    mode_points = [p for p in points_for_cut if p["oven_mode"] == wanted_mode]
    selected_mode_points = mode_points
    source_mode = wanted_mode

    if not selected_mode_points:
        bake_points = [p for p in points_for_cut if p["oven_mode"] == "bake"]
        convection_points = [p for p in points_for_cut if p["oven_mode"] == "convection"]
        fallback_candidates = []
        if bake_points:
            fallback_candidates.append(("bake", bake_points))
        if convection_points:
            fallback_candidates.append(("convection", convection_points))
        if not fallback_candidates:
            return None

        fallback_candidates.sort(
            key=lambda entry: min(abs(float(p["thickness_in"]) - inputs.thickness_in) for p in entry[1])
        )
        source_mode, selected_mode_points = fallback_candidates[0]

    coeff = interpolate_thermal_coefficients(selected_mode_points, inputs.thickness_in, calibration_data)
    if coeff is None:
        return None

    converted = convert_thermal_for_mode(coeff, source_mode, inputs.oven_mode)
    predicted = predict_range_from_thermal(converted, calibration_data, inputs, pull_temp_f)
    if predicted is None:
        return None

    low, high = apply_specialized_weight_adjustment(
        predicted[0], predicted[1], starter_data, inputs
    )
    return low, high


def regression_fallback(
    starter_data: Dict[str, Any],
    calibration_data: Dict[str, Any],
    inputs: Inputs,
    pull_temp_f: float,
    cut_class: str,
) -> Tuple[int, int]:
    observations = build_calibration_observations(starter_data, calibration_data)
    estimated_weight = resolve_input_weight_oz(starter_data, inputs)
    target = {
        "method_id": inputs.method_id,
        "oven_mode": inputs.oven_mode,
        "cut_class": cut_class,
        "thickness_in": inputs.thickness_in,
        "oven_temp_f": float(inputs.oven_temp_f),
        "pull_temp_f": float(pull_temp_f),
        "estimated_weight_oz": float(estimated_weight),
    }
    low, high = predict_with_hybrid_regression(observations, target)
    if inputs.start_temp_assumption == "tempered":
        low, high = round_range(low * 0.85, high * 0.85)
    return low, high


def resolve_reverse_sear_estimate(
    starter_data: Dict[str, Any], calibration_data: Dict[str, Any], inputs: Inputs
) -> Dict[str, Any]:
    cut = next((c for c in starter_data["cuts"] if c["cut_id"] == inputs.cut_id), None)
    if not cut:
        return {"status": "error", "message": "Invalid cut."}
    doneness = next(
        (d for d in starter_data["doneness_targets"] if d["doneness_id"] == inputs.doneness_id),
        None,
    )
    if not doneness:
        return {"status": "error", "message": "Invalid doneness."}

    pull_temp_f = int(doneness["pull_temp_f"])
    rest_minutes = int(doneness.get("rest_minutes_default", 5))

    specialized = specialized_reverse_sear_range(
        starter_data,
        calibration_data,
        inputs,
        float(pull_temp_f),
        cut["cook_class"],
    )
    reg_low, reg_high = regression_fallback(
        starter_data,
        calibration_data,
        inputs,
        float(pull_temp_f),
        cut["cook_class"],
    )

    if specialized is None:
        low, high = reg_low, reg_high
    else:
        blend_specialized = 0.72
        blend_regression = 1 - blend_specialized
        low, high = round_range(
            specialized[0] * blend_specialized + reg_low * blend_regression,
            specialized[1] * blend_specialized + reg_high * blend_regression,
        )

    if inputs.oven_mode == "convection":
        bake_inputs = Inputs(
            cut_id=inputs.cut_id,
            doneness_id=inputs.doneness_id,
            thickness_in=inputs.thickness_in,
            weight_oz=inputs.weight_oz,
            oven_temp_f=inputs.oven_temp_f,
            oven_mode="bake",
            start_temp_assumption=inputs.start_temp_assumption,
            method_id=inputs.method_id,
        )
        bake_estimate = resolve_reverse_sear_estimate(starter_data, calibration_data, bake_inputs)
        if bake_estimate.get("status") == "ok":
            bake_low = bake_estimate["time_low"]
            bake_high = bake_estimate["time_high"]
            already_faster = low < bake_low and high < bake_high
            if not already_faster:
                low_cap = max(1, round(bake_low * CONVECTION_FACTOR))
                high_cap = max(1, round(bake_high * CONVECTION_FACTOR))
                if bake_low > 1 and low_cap >= bake_low:
                    low_cap = bake_low - 1
                if bake_high > 1 and high_cap >= bake_high:
                    high_cap = bake_high - 1
                low, high = round_range(min(low, low_cap), min(high, max(low_cap, high_cap)))

    instruction = (
        f"Reverse sear: place steak on a wire cooling rack over a sheet pan, "
        f"oven about {low} min at {inputs.oven_temp_f}F, then sear "
        f"{DEFAULT_REVERSE_SEAR_SECONDS_PER_SIDE}s/side. Pull at {pull_temp_f}F, "
        f"rest {rest_minutes} min."
    )

    return {
        "status": "ok",
        "time_low": low,
        "time_high": high,
        "pull_temp_f": pull_temp_f,
        "rest_minutes": rest_minutes,
        "instruction": instruction,
    }


def load_data() -> Tuple[Dict[str, Any], Dict[str, Any]]:
    with STARTER_PATH.open("r", encoding="utf-8") as f:
        starter = json.load(f)
    with CALIBRATION_PATH.open("r", encoding="utf-8") as f:
        calibration = json.load(f)
    return starter, calibration


def resolve_embedded_frontend_url() -> Optional[str]:
    secret_enable_exact = ""
    secret_url = ""
    try:
        secret_enable_exact = str(st.secrets.get("use_exact_embed", ""))  # type: ignore[arg-type]
    except Exception:
        secret_enable_exact = ""
    try:
        secret_url = st.secrets.get("frontend_url", "")  # type: ignore[arg-type]
    except Exception:
        secret_url = ""

    env_enable_exact = os.getenv("STEAK_USE_EMBED", "")
    env_url = os.getenv("STEAK_FRONTEND_URL", "")

    enable_exact = (
        str(secret_enable_exact).strip().lower() in {"1", "true", "yes", "on"}
        or str(env_enable_exact).strip().lower() in {"1", "true", "yes", "on"}
    )
    if not enable_exact:
        return None

    # Priority once enabled: Streamlit secret > env var.
    chosen = (secret_url or env_url).strip()
    if not chosen:
        return None
    return chosen


def render_exact_embedded_ui() -> bool:
    frontend_url = resolve_embedded_frontend_url()
    if not frontend_url:
        return False

    st.set_page_config(page_title="Cook Time Estimater", layout="wide")
    st.markdown(
        """
        <style>
        [data-testid="stHeader"], [data-testid="stToolbar"], #MainMenu, footer {
          display: none !important;
        }
        [data-testid="stAppViewContainer"] .main .block-container {
          max-width: 1120px;
          padding-top: 0.5rem;
          padding-bottom: 0.5rem;
        }
        </style>
        """,
        unsafe_allow_html=True,
    )
    components.iframe(frontend_url, height=1700, scrolling=True)
    st.caption(
        "Exact UI mode: rendering the React/Tailwind app directly. "
        "Set `use_exact_embed=true` + `frontend_url` in Streamlit secrets "
        "(or `STEAK_USE_EMBED=1` + `STEAK_FRONTEND_URL`) to change source."
    )
    return True


def inject_ui_style() -> None:
    st.markdown(
        """
        <style>
        @import url("https://fonts.googleapis.com/css2?family=Cinzel:wght@700;800;900&family=Oswald:wght@500;600;700&family=Barlow+Condensed:wght@500;600;700;800&display=swap");

        :root {
          --bg-top: #f8efe2;
          --bg-mid: #f4e8d8;
          --bg-bottom: #ecdecb;
          --hero-ink: #2a1f1a;
          --hero-sub: #5f4a40;
          --card: #fff9f1;
          --card-soft: #fffdf9;
          --ink: #221814;
          --muted: #5a473d;
          --accent: #8c1f2d;
          --accent-2: #a23a33;
          --accent-soft: #f3e3d2;
          --slider-accent: #7e2c29;
          --stroke: rgba(80, 51, 43, 0.22);
          --line-strong: rgba(80, 51, 43, 0.34);
          --shadow: 0 14px 30px rgba(56, 32, 23, 0.14);
        }

        [data-testid="stHeader"], [data-testid="stToolbar"], #MainMenu, footer {
          display: none !important;
        }

        [data-testid="stAppViewContainer"] {
          --primary-color: var(--accent);
          background:
            radial-gradient(circle at 14% 0%, rgba(169, 78, 60, 0.16), transparent 40%),
            radial-gradient(circle at 95% 14%, rgba(150, 84, 68, 0.14), transparent 42%),
            linear-gradient(165deg, var(--bg-top) 0%, var(--bg-mid) 62%, var(--bg-bottom) 100%);
        }

        [data-testid="stAppViewContainer"] .main .block-container {
          max-width: 1080px;
          padding-top: 0.5rem;
          padding-bottom: 1.2rem;
        }

        html, body, [data-testid="stAppViewContainer"] * {
          font-family: "Barlow Condensed", "Segoe UI", sans-serif;
        }

        .hero-panel {
          border: 1px solid var(--stroke);
          border-radius: 12px;
          padding: 12px 18px 10px;
          margin-bottom: 14px;
          background:
            radial-gradient(circle at 50% -140%, rgba(140, 31, 45, 0.08), transparent 58%),
            linear-gradient(164deg, #fff9f1 0%, #f6eadb 58%, #f1e2d0 100%);
          box-shadow: var(--shadow);
        }

        .hero-kicker {
          margin: 0;
          text-align: center;
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.16em;
          text-transform: uppercase;
          color: var(--muted);
          transform: none;
        }

        .hero-title {
          margin: 4px 0 0;
          text-align: center;
          font-family: "Cinzel", "Times New Roman", serif;
          font-size: clamp(30px, 4.9vw, 56px);
          line-height: 0.98;
          font-weight: 800;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--ink);
          text-shadow: 0 1px 0 rgba(255, 255, 255, 0.35);
        }

        .hero-meta {
          margin: 0;
          padding-top: 5px;
          display: grid;
          grid-template-columns: 1fr auto 1fr;
          align-items: center;
          gap: 8px;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: var(--muted);
        }

        .hero-meta span:nth-child(1) {
          text-align: left;
        }

        .hero-meta span:nth-child(2) {
          text-align: center;
        }

        .hero-meta span:nth-child(3) {
          text-align: right;
        }

        @media (max-width: 760px) {
          .hero-panel {
            padding: 10px 12px 9px;
          }

          .hero-kicker {
            font-size: 10px;
            letter-spacing: 0.12em;
          }

          .hero-title {
            font-size: clamp(28px, 8.5vw, 42px);
            letter-spacing: 0.08em;
          }

          .hero-meta {
            font-size: 10px;
            letter-spacing: 0.11em;
          }
        }

        [data-testid="stVerticalBlockBorderWrapper"] {
          border: 1px solid var(--stroke) !important;
          background: var(--card) !important;
          border-radius: 12px !important;
          box-shadow: var(--shadow) !important;
        }

        [data-testid="stVerticalBlockBorderWrapper"] > div {
          padding-top: 0.45rem !important;
          padding-bottom: 0.45rem !important;
        }

        /* Nested bordered containers are used as segmented input groups. */
        [data-testid="stVerticalBlockBorderWrapper"] [data-testid="stVerticalBlockBorderWrapper"] {
          border-width: 0.9px !important;
          border-radius: 8px !important;
          background: var(--card-soft) !important;
          box-shadow: none !important;
        }

        [data-testid="stVerticalBlockBorderWrapper"] [data-testid="stVerticalBlockBorderWrapper"] > div {
          padding-top: 0.22rem !important;
          padding-bottom: 0.22rem !important;
        }

        [data-testid="stVerticalBlockBorderWrapper"] [data-testid="stMarkdown"] p,
        [data-testid="stVerticalBlockBorderWrapper"] label,
        [data-testid="stVerticalBlockBorderWrapper"] span,
        [data-testid="stVerticalBlockBorderWrapper"] li,
        [data-testid="stVerticalBlockBorderWrapper"] h1,
        [data-testid="stVerticalBlockBorderWrapper"] h2,
        [data-testid="stVerticalBlockBorderWrapper"] h3,
        [data-testid="stVerticalBlockBorderWrapper"] h4 {
          color: var(--ink);
        }

        .card-title {
          margin: 0 0 6px;
          font-family: "Oswald", "Segoe UI", sans-serif;
          font-size: 29px;
          line-height: 1;
          font-weight: 700;
          letter-spacing: 0.05em;
          text-transform: uppercase;
          color: var(--ink);
        }

        .field-label {
          margin: 0 0 4px;
          font-family: "Oswald", "Segoe UI", sans-serif;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--muted);
        }

        .field-note {
          margin-top: 1px;
          margin-bottom: 2px;
          font-size: 12px;
          font-weight: 600;
          color: var(--muted);
        }

        .slider-readout {
          margin: 0;
          font-size: 12px;
          font-weight: 800;
          letter-spacing: 0.01em;
          color: var(--ink);
        }

        .doneness-ticks,
        .major-ticks {
          position: relative;
          height: 14px;
          margin-top: 2px;
          margin-bottom: 2px;
          line-height: 1;
        }

        .doneness-ticks {
          height: 20px;
          margin-top: 4px;
          margin-bottom: 4px;
        }

        .major-ticks {
          height: 20px;
          margin-top: 4px;
          margin-bottom: 4px;
        }

        .doneness-ticks span,
        .major-ticks span {
          position: absolute;
          top: 0;
          left: calc(11px + (100% - 22px) * var(--pos));
          transform: translateX(-50%);
          white-space: nowrap;
          color: var(--muted);
          text-align: center;
        }

        .doneness-ticks span {
          font-size: 13px;
          font-weight: 500;
          color: var(--ink);
        }

        .major-ticks span {
          font-size: 13px;
          font-weight: 500;
          color: var(--ink);
          text-transform: uppercase;
        }

        .doneness-ticks span.edge-left,
        .major-ticks span.edge-left {
          transform: none;
        }

        .doneness-ticks span.edge-right,
        .major-ticks span.edge-right {
          transform: translateX(-100%);
        }

        div[data-testid="stSelectbox"] div[data-baseweb="select"] > div,
        div[data-testid="stTextInput"] input,
        div[data-testid="stNumberInput"] input {
          background: var(--card-soft) !important;
          border-color: var(--stroke) !important;
          color: var(--ink) !important;
        }

        div[data-testid="stSelectbox"] div[data-baseweb="select"] > div {
          min-height: 38px;
        }

        div[data-testid="stSlider"],
        div[data-testid="stSelectSlider"] {
          margin-top: 4px;
          margin-bottom: 0;
        }

        /* Cohesive slider colors (less neon, more brand-muted). */
        div[data-baseweb="slider"] > div > div:nth-child(1) {
          background: rgba(92, 63, 50, 0.24) !important;
          height: 4px !important;
        }

        div[data-baseweb="slider"] > div > div:nth-child(2) {
          background: linear-gradient(90deg, var(--slider-accent), #995047) !important;
          height: 4px !important;
        }

        div[data-baseweb="slider"] [role="slider"] {
          width: 22px !important;
          height: 22px !important;
          background: var(--slider-accent) !important;
          border: 2px solid #f3e3d2 !important;
          border-radius: 999px !important;
          box-shadow: 0 1px 4px rgba(58, 28, 21, 0.28) !important;
        }

        div[data-testid="stSlider"] p,
        div[data-testid="stSelectSlider"] p {
          color: var(--muted) !important;
          font-size: 13px !important;
          font-weight: 700 !important;
        }

        div[data-baseweb="slider"] span {
          color: var(--muted) !important;
          font-size: 13px !important;
          font-weight: 700 !important;
        }

        /* Streamlit slider thumb value label (actual selected value above thumb). */
        div[data-testid="stSliderThumbValue"] {
          color: var(--muted) !important;
          font-size: 14px !important;
          font-weight: 800 !important;
        }

        div[data-testid="stSliderThumbValue"] * {
          color: inherit !important;
        }

        div[data-testid="stSelectSlider"] [data-baseweb="slider"] p,
        div[data-testid="stSelectSlider"] [data-baseweb="slider"] span {
          color: var(--muted) !important;
        }

        div[data-testid="stButton"] > button {
          font-family: "Barlow Condensed", "Segoe UI", sans-serif !important;
          font-weight: 700 !important;
          letter-spacing: 0.01em;
          border-radius: 12px !important;
          border: 1px solid var(--stroke) !important;
          background: var(--card-soft) !important;
          color: var(--ink) !important;
        }

        div[data-testid="stButton"] > button[kind="primary"] {
          font-weight: 800 !important;
          border-color: rgba(140, 31, 45, 0.5) !important;
          background: linear-gradient(155deg, #f8eee2, #eedecb 70%, #e6d2bc) !important;
          color: #2a1f1a !important;
          box-shadow: 0 8px 18px rgba(74, 43, 31, 0.16) !important;
        }

        div[data-testid="stRadio"] > div {
          gap: 0.8rem;
        }

        .result-label {
          margin: 0 0 2px;
          font-size: 22px;
          font-weight: 700;
          color: var(--ink);
        }

        .result-time {
          margin: 0 0 10px;
          font-family: "Oswald", "Segoe UI", sans-serif;
          font-size: clamp(62px, 8.5vw, 96px);
          line-height: 0.9;
          font-weight: 700;
          letter-spacing: -0.015em;
          color: var(--accent);
          text-shadow: 0 2px 0 rgba(34, 24, 20, 0.12);
        }

        .step-title {
          margin: 8px 0 6px;
          font-family: "Oswald", "Segoe UI", sans-serif;
          font-size: 14px;
          letter-spacing: 0.11em;
          text-transform: uppercase;
          color: var(--muted);
        }

        .step-box {
          border: 1px solid var(--stroke);
          border-radius: 12px;
          background: var(--card-soft);
          padding: 11px 12px;
          margin-bottom: 7px;
          font-size: 16px;
          line-height: 1.5;
          color: var(--ink);
        }

        .quick-summary {
          border: 1px solid rgba(95, 64, 54, 0.25);
          border-radius: 12px;
          background: var(--card-soft);
          padding: 8px 10px;
          margin-top: 2px;
          font-size: 15px;
          line-height: 1.5;
          color: var(--ink);
        }

        .quick-summary b {
          font-weight: 800;
        }

        .disclaimer {
          margin-top: 6px;
          font-size: 12px;
          color: var(--muted);
        }

        .cooking-card-wrap {
          min-height: clamp(660px, calc(100vh - 190px), 940px);
          display: flex;
          flex-direction: column;
        }

        .cooking-card-foot {
          margin-top: auto;
          padding-top: 4px;
        }

        @media (max-width: 1024px) {
          .cooking-card-wrap {
            min-height: 0;
          }
        }

        @media (max-width: 760px) {
          .result-time {
            font-size: clamp(54px, 14vw, 84px);
          }
        }

        .method-static {
          min-height: 42px;
          border: 1px solid var(--stroke);
          border-radius: 8px;
          background: var(--card-soft);
          padding: 0 8px;
          display: flex;
          align-items: center;
          font-size: 13px;
          font-weight: 500;
          color: var(--ink);
        }
        </style>
        """,
        unsafe_allow_html=True,
    )


def get_default_doneness_id(starter_data: Dict[str, Any]) -> str:
    doneness_ids = [d["doneness_id"] for d in starter_data["doneness_targets"]]
    if "med_rare" in doneness_ids:
        return "med_rare"
    return doneness_ids[0]


def get_default_oven_mode(starter_data: Dict[str, Any]) -> str:
    oven_modes = starter_data.get("enums", {}).get("oven_mode", [])
    if "bake" in oven_modes:
        return "bake"
    if oven_modes:
        return oven_modes[0]
    return "bake"


def get_cut_by_id(starter_data: Dict[str, Any], cut_id: str) -> Dict[str, Any]:
    return next(c for c in starter_data["cuts"] if c["cut_id"] == cut_id)


def apply_cut_defaults(starter_data: Dict[str, Any], cut_id: str) -> None:
    cut = get_cut_by_id(starter_data, cut_id)
    thickness = float(clamp(float(cut.get("typical_thickness_in", 1.25)), 0.5, 2.5))
    st.session_state.selected_cut_id = cut_id
    st.session_state.thickness_in = thickness
    st.session_state.weight_custom = False
    st.session_state.weight_slider = float(
        round(estimate_selection_weight_oz(starter_data, cut_id, thickness) * 2) / 2
    )


def initialize_state(starter_data: Dict[str, Any]) -> None:
    cuts = starter_data["cuts"]
    first_cut_id = cuts[0]["cut_id"]

    if "selected_cut_id" not in st.session_state:
        st.session_state.selected_cut_id = first_cut_id
    if not any(c["cut_id"] == st.session_state.selected_cut_id for c in cuts):
        st.session_state.selected_cut_id = first_cut_id

    selected_cut = get_cut_by_id(starter_data, st.session_state.selected_cut_id)

    if "doneness_id" not in st.session_state:
        st.session_state.doneness_id = get_default_doneness_id(starter_data)
    if "thickness_in" not in st.session_state:
        st.session_state.thickness_in = float(
            clamp(float(selected_cut.get("typical_thickness_in", 1.25)), 0.5, 2.5)
        )
    if "oven_temp_f" not in st.session_state:
        st.session_state.oven_temp_f = 250
    if "oven_mode" not in st.session_state:
        st.session_state.oven_mode = get_default_oven_mode(starter_data)
    if "start_temp_assumption" not in st.session_state:
        st.session_state.start_temp_assumption = "fridge"
    if "weight_custom" not in st.session_state:
        st.session_state.weight_custom = False
    if "weight_slider" not in st.session_state:
        st.session_state.weight_slider = float(
            round(
                estimate_selection_weight_oz(
                    starter_data,
                    st.session_state.selected_cut_id,
                    st.session_state.thickness_in,
                )
                * 2
            )
            / 2
        )


def bordered_container():
    try:
        return st.container(border=True)
    except TypeError:
        # Backward compatibility for older Streamlit versions without border support.
        return st.container()


def safe_rerun() -> None:
    rerun_fn = getattr(st, "rerun", None)
    if callable(rerun_fn):
        rerun_fn()
        return
    legacy_rerun = getattr(st, "experimental_rerun", None)
    if callable(legacy_rerun):
        legacy_rerun()


def render_hero() -> None:
    st.markdown(
        """
        <div class="hero-panel">
          <p class="hero-kicker">Better steak starts with better timing</p>
          <h1 class="hero-title">Select. Sear. Serve.</h1>
          <p class="hero-meta"><span></span><span>Cook Time Estimater</span><span></span></p>
        </div>
        """,
        unsafe_allow_html=True,
    )


def render_result_card(result: Dict[str, Any], oven_temp_f: int, oven_mode: str) -> None:
    st.markdown('<p class="card-title" style="font-size:36px">Cooking Card</p>', unsafe_allow_html=True)

    if result["status"] != "ok":
        st.error(result.get("message", "No estimate available."))
        return

    st.markdown(
        f"""
        <div class="cooking-card-wrap">
          <div class="cooking-card-main">
            <p class="result-label">Estimated cook time in the oven is:</p>
            <p class="result-time">{result['time_low']} minutes</p>
            <p class="step-title">Step-by-step</p>
            <div class="step-box"><b>Step 1:</b> Preheat oven to {oven_temp_f}F in {oven_mode} mode. Set steak on a wire cooling rack over a sheet pan so it sits above the hot surface and cooks more evenly.</div>
            <div class="step-box"><b>Step 2:</b> Cook in the oven for about {result['time_low']} minutes. This uses the low-end estimate, so start temping the steak right at that time.</div>
            <div class="step-box"><b>Step 3:</b> Pull at 125F and rest for 5 minutes. While it rests, heat a skillet on high (use good ventilation, as it can get smoky), add tallow or a high smoke-point oil, then sear 90 seconds per side.</div>
            <div class="step-box"><b>Step 4:</b> Slice against the grain and serve.</div>
            <div class="quick-summary"><b>Quick summary:</b> Oven to temp, rack + sheet pan, cook to time, pull at 125F, rest 5 min, then sear 90 sec per side.</div>
          </div>
          <div class="cooking-card-foot">
            <p class="disclaimer">Oven temps can run hot or cool. Verify doneness with an instant-read thermometer.</p>
          </div>
        </div>
        """,
        unsafe_allow_html=True,
    )


def main() -> None:
    # Exact match mode: embed the actual React frontend for true 1:1 visuals/behavior.
    if render_exact_embedded_ui():
        return

    st.set_page_config(page_title="Cook Time Estimater", layout="wide")

    if not STARTER_PATH.exists() or not CALIBRATION_PATH.exists():
        st.error("Missing required JSON files next to streamlit_app.py.")
        st.write(f"Expected: {STARTER_PATH.name}, {CALIBRATION_PATH.name}")
        return

    starter_data, calibration_data = load_data()
    inject_ui_style()
    initialize_state(starter_data)
    render_hero()

    cuts = starter_data["cuts"]
    left_col, right_col = st.columns([1.04, 0.96], gap="medium")

    with left_col:
        with bordered_container():
            st.markdown('<p class="card-title">Inputs</p>', unsafe_allow_html=True)

            st.markdown('<p class="field-label">Steak cut</p>', unsafe_allow_html=True)
            for i in range(0, len(cuts), 2):
                row_cols = st.columns(2, gap="small")
                for j in range(2):
                    idx = i + j
                    if idx >= len(cuts):
                        continue
                    cut = cuts[idx]
                    selected = st.session_state.selected_cut_id == cut["cut_id"]
                    if row_cols[j].button(
                        cut["display_name"],
                        key=f"cut_tile_{cut['cut_id']}",
                        type="primary" if selected else "secondary",
                        use_container_width=True,
                    ):
                        apply_cut_defaults(starter_data, cut["cut_id"])
                        safe_rerun()

            selected_cut = get_cut_by_id(starter_data, st.session_state.selected_cut_id)

            with bordered_container():
                st.markdown('<p class="field-label">Doneness</p>', unsafe_allow_html=True)
                doneness_order = ["rare", "med_rare", "medium", "med_well", "well"]
                doneness_targets = sorted(
                    starter_data["doneness_targets"],
                    key=lambda d: (
                        doneness_order.index(d["doneness_id"])
                        if d["doneness_id"] in doneness_order
                        else 999,
                        d["target_temp_f"],
                    ),
                )
                doneness_ids = [d["doneness_id"] for d in doneness_targets]
                if st.session_state.doneness_id not in doneness_ids:
                    st.session_state.doneness_id = get_default_doneness_id(starter_data)

                st.select_slider(
                    "Doneness level",
                    options=doneness_ids,
                    key="doneness_id",
                    format_func=lambda doneness_id: doneness_id.replace("_", " ").title(),
                    label_visibility="collapsed",
                )
                selected_doneness = next(
                    d for d in doneness_targets if d["doneness_id"] == st.session_state.doneness_id
                )
                doneness_label = selected_doneness["doneness_id"].replace("_", " ").title()
                st.markdown(
                    '<div class="doneness-ticks"><span class="edge-left" style="--pos:0">Rare</span><span style="--pos:0.25">Med Rare</span><span style="--pos:0.5">Med</span><span style="--pos:0.75">Med Well</span><span class="edge-right" style="--pos:1">Well Done</span></div>',
                    unsafe_allow_html=True,
                )
                st.markdown(
                    f'<p class="field-note">Doneness: {doneness_label} • Target {selected_doneness["target_temp_f"]}F / Pull {selected_doneness["pull_temp_f"]}F</p>',
                    unsafe_allow_html=True,
                )

            c1, c2 = st.columns(2, gap="small")
            with c1:
                with bordered_container():
                    st.markdown('<p class="field-label">Thickness</p>', unsafe_allow_html=True)
                    thickness_in = float(
                        st.slider(
                        "Thickness (in)",
                        min_value=0.5,
                        max_value=2.5,
                        step=0.25,
                        key="thickness_in",
                        label_visibility="collapsed",
                        )
                    )
                    st.markdown(
                        f'<p class="field-note">Thickness: {thickness_in:.2f} in</p>',
                        unsafe_allow_html=True,
                    )

            with c2:
                with bordered_container():
                    auto_weight = estimate_selection_weight_oz(
                        starter_data, st.session_state.selected_cut_id, float(thickness_in)
                    )
                    if not st.session_state.weight_custom:
                        st.session_state.weight_slider = float(round(auto_weight * 2) / 2)

                    st.markdown('<p class="field-label">Steak weight</p>', unsafe_allow_html=True)
                    st.session_state.weight_slider = float(
                        clamp(float(st.session_state.weight_slider), 4, 64)
                    )
                    weight_slider = float(
                        st.slider(
                            "Steak weight (oz)",
                            min_value=4.0,
                            max_value=64.0,
                            step=0.5,
                            key="weight_slider",
                            label_visibility="collapsed",
                        )
                    )
                    if not st.session_state.weight_custom and abs(weight_slider - auto_weight) > 0.01:
                        st.session_state.weight_custom = True

                    weight_mode_note = (
                        f"Custom (default {auto_weight:.1f} oz)"
                        if st.session_state.weight_custom
                        else f"Default {auto_weight:.1f} oz"
                    )
                    st.markdown(
                        f'<p class="field-note">Weight: {weight_slider:.1f} oz • {weight_mode_note}</p>',
                        unsafe_allow_html=True,
                    )

            with bordered_container():
                st.markdown('<p class="field-label">Oven temperature</p>', unsafe_allow_html=True)
                oven_temp_f = int(
                    st.slider(
                        "Oven temperature (F)",
                        min_value=250,
                        max_value=500,
                        step=25,
                        key="oven_temp_f",
                        format="%dF",
                        label_visibility="collapsed",
                    )
                )
                st.markdown(
                    f'<p class="slider-readout">Oven temp: {oven_temp_f}F</p>',
                    unsafe_allow_html=True,
                )
                st.markdown(
                    '<div class="major-ticks"><span class="edge-left" style="--pos:0">250</span><span style="--pos:0.2">300</span><span style="--pos:0.4">350</span><span style="--pos:0.6">400</span><span style="--pos:0.8">450</span><span class="edge-right" style="--pos:1">500</span></div>',
                    unsafe_allow_html=True,
                )

            c3, c4 = st.columns(2, gap="small")
            with c3:
                with bordered_container():
                    st.markdown('<p class="field-label">Oven mode</p>', unsafe_allow_html=True)
                    oven_mode_options = ["bake", "convection"]
                    oven_mode_index = (
                        oven_mode_options.index(st.session_state.oven_mode)
                        if st.session_state.oven_mode in oven_mode_options
                        else 0
                    )
                    st.session_state.oven_mode = st.selectbox(
                        "Oven mode",
                        options=oven_mode_options,
                        index=oven_mode_index,
                        label_visibility="collapsed",
                    )

            with c4:
                with bordered_container():
                    st.markdown('<p class="field-label">Cooking method</p>', unsafe_allow_html=True)
                    st.markdown(
                        '<div class="method-static">Reverse sear (oven first, sear after)</div>',
                        unsafe_allow_html=True,
                    )

            st.markdown('<p class="field-label">Starting temp</p>', unsafe_allow_html=True)
            start_c1, start_c2 = st.columns(2, gap="small")
            if start_c1.button(
                "From fridge",
                key="start_temp_fridge_btn",
                type="primary" if st.session_state.start_temp_assumption == "fridge" else "secondary",
                use_container_width=True,
            ):
                st.session_state.start_temp_assumption = "fridge"
            if start_c2.button(
                "Tempered",
                key="start_temp_tempered_btn",
                type="primary" if st.session_state.start_temp_assumption == "tempered" else "secondary",
                use_container_width=True,
            ):
                st.session_state.start_temp_assumption = "tempered"

            weight_oz: Optional[float]
            if st.session_state.weight_custom:
                weight_oz = float(st.session_state.weight_slider)
            else:
                weight_oz = None

            inputs = Inputs(
                cut_id=st.session_state.selected_cut_id,
                doneness_id=st.session_state.doneness_id,
                thickness_in=float(st.session_state.thickness_in),
                weight_oz=weight_oz,
                oven_temp_f=int(st.session_state.oven_temp_f),
                oven_mode=st.session_state.oven_mode,
                start_temp_assumption=st.session_state.start_temp_assumption,
            )
            result = resolve_reverse_sear_estimate(starter_data, calibration_data, inputs)

    with right_col:
        with bordered_container():
            render_result_card(result, int(st.session_state.oven_temp_f), st.session_state.oven_mode)


if __name__ == "__main__":
    main()
