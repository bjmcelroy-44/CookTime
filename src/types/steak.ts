export type ConfidenceLevel = "low" | "medium" | "high" | string;

export interface Cut {
  cut_id: string;
  display_name: string;
  cook_class: string;
  typical_thickness_in: number;
  typical_weight_oz?: number;
  notes?: string;
}

export interface Method {
  method_id: string;
  display_name: string;
  default_oven_mode: string;
  default_pan?: string;
  notes?: string;
}

export interface DonenessTarget {
  doneness_id: string;
  target_temp_f: number;
  pull_temp_f: number;
  rest_minutes_default: number;
}

export interface CookTimeModel {
  model_id: string;
  cut_class: string;
  method_id: string;
  oven_temp_f: number;
  oven_mode: string;
  thickness_in_min: number;
  thickness_in_max: number;
  doneness_id: string;
  time_min_low: number;
  time_min_high: number;
  pull_temp_override_f: number | null;
  rest_minutes_override: number | null;
  start_temp_assumption?: string;
  pan_assumption?: string;
  sear_seconds_per_side: number | null;
  flip_count?: number;
  data_source?: string;
  confidence: ConfidenceLevel;
  notes?: string;
}

export interface TimeAdjustment {
  adjustment_id: string;
  applies_to: Record<string, string | number | boolean | undefined>;
  factor: number | null;
  delta_minutes: number | null;
  priority: number;
  notes?: string;
}

export interface SteakData {
  version: string;
  enums: {
    oven_mode: string[];
    start_temp_assumption?: string[];
    [key: string]: unknown;
  };
  cuts: Cut[];
  methods: Method[];
  doneness_targets: DonenessTarget[];
  cook_time_models: CookTimeModel[];
  time_adjustments: TimeAdjustment[];
}
