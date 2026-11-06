export type OpenWeatherFetcher = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export type OpenWeatherOneCallVersion = '3.0' | '4.0';

export type OpenWeatherDeps = {
  apiKey: string;
  fetch: OpenWeatherFetcher;
  oneCallVersion?: OpenWeatherOneCallVersion;
};

export type OpenWeatherArgs = {
  action: string;
  city?: string;
  lat?: number;
  lon?: number;
  exclude?: string;
  units?: string;
  lang?: string;
  date?: string;
  tz?: string;
};

export type WeatherCondition = {
  id?: number;
  main?: string;
  description?: string;
  icon?: string;
};

export type DailyTemperature = {
  day?: number;
  min?: number;
  max?: number;
  night?: number;
  eve?: number;
  morn?: number;
};

export type PrecipitationAmount = {
  '1h'?: number;
};

export type WeatherAlert = {
  id?: string;
  sender_name?: string;
  event?: string;
  start?: number;
  end?: number;
  description?: string;
  tags?: string[];
};

export type OneCallRecord = {
  dt?: number;
  sunrise?: number;
  sunset?: number;
  moonrise?: number;
  moonset?: number;
  moon_phase?: number;
  temp?: number | DailyTemperature;
  feels_like?: number | DailyTemperature;
  pressure?: number;
  humidity?: number;
  dew_point?: number;
  uvi?: number;
  clouds?: number;
  visibility?: number;
  wind_speed?: number;
  wind_deg?: number;
  wind_gust?: number;
  pop?: number;
  precipitation?: number;
  rain?: number | PrecipitationAmount;
  snow?: number | PrecipitationAmount;
  weather?: WeatherCondition[];
  alerts?: string[];
};

export type OneCallResponse = {
  lat?: number;
  lon?: number;
  timezone?: string;
  timezone_offset?: number;
  data?: OneCallRecord[];
  next?: string;
  prev?: string;
};

export type CurrentForecastResult = {
  lat?: number;
  lon?: number;
  timezone?: string;
  timezone_offset?: number;
  current?: OneCallRecord;
  minutely?: OneCallRecord[];
  hourly?: OneCallRecord[];
  daily?: OneCallRecord[];
  alerts?: WeatherAlert[];
  errors?: string[];
};

export type DailyAggregationResult = {
  lat?: number;
  lon?: number;
  tz?: string;
  date: string;
  units: string;
  cloud_cover?: { afternoon?: number };
  humidity?: {
    morning?: number;
    afternoon?: number;
    evening?: number;
    night?: number;
  };
  precipitation?: { total?: number };
  temperature?: {
    min?: number;
    max?: number;
    morning?: number;
    afternoon?: number;
    evening?: number;
    night?: number;
  };
  pressure?: { afternoon?: number };
  wind?: {
    max?: {
      speed?: number;
      direction?: number;
    };
  };
};

export type OverviewResult = {
  lat?: number;
  lon?: number;
  tz?: string;
  date: string;
  units: string;
  weather_overview: string;
};
