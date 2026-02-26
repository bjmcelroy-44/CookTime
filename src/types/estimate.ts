export interface UiEstimateSuccess {
  status: "ok";
  timeRangeMinutes: {
    low: number;
    high: number;
  };
  pullTempF: number;
  restMinutes: number;
  instruction: string;
  messages?: string[];
}

export interface UiEstimateError {
  status: "error";
  message: string;
}

export type UiEstimateResult = UiEstimateSuccess | UiEstimateError;
