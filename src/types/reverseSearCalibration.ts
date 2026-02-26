export interface ReverseSearCalibrationPoint {
  profile_id: string;
  cut_classes: string[];
  oven_mode: "bake" | "convection";
  thickness_in: number;
  typical_weight_oz?: number;
  start_temp_f?: number;
  oven_actual_f?: number;
  time_to_120_low: number;
  time_to_120_high: number;
  time_to_125_low: number | null;
  time_to_125_high: number | null;
  sample_count: number;
}

export interface ReverseSearCalibrationData {
  version: string;
  source: string;
  base_oven_temp_f: number;
  default_minutes_per_degree: {
    low: number;
    high: number;
  };
  profiles: ReverseSearCalibrationPoint[];
}
