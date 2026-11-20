import { mapUnitsToOpenWeather, roundDegree, roundTemperatures, unitSuffix } from './units';

describe('OpenWeather units', () => {
  it('maps display units onto OpenWeather units and defaults to metric', () => {
    expect(mapUnitsToOpenWeather()).toBe('metric');
    expect(mapUnitsToOpenWeather('Celsius')).toBe('metric');
    expect(mapUnitsToOpenWeather('Kelvin')).toBe('standard');
    expect(mapUnitsToOpenWeather('Fahrenheit')).toBe('imperial');
    expect(mapUnitsToOpenWeather('Rankine')).toBe('metric');
  });

  it('returns a display suffix for each OpenWeather unit', () => {
    expect(unitSuffix('metric')).toBe('°C');
    expect(unitSuffix('imperial')).toBe('°F');
    expect(unitSuffix('standard')).toBe(' K');
  });

  it('rounds a temperature to the nearest degree', () => {
    expect(roundDegree(20.4)).toBe(20);
    expect(roundDegree(18.6)).toBe(19);
    expect(roundDegree(7.4)).toBe(7);
    expect(roundDegree(21.9)).toBe(22);
  });

  it('rounds nested temperature fields and leaves non-temp numbers intact', () => {
    const rounded = roundTemperatures({
      current: { temp: 293.15, feels_like: 295.4, humidity: 75, dew_point: 280.6 },
      daily: [{ temp: { day: 293.15, night: 283.49, min: 279.9, max: 294.2 } }],
      humidity: 60.4,
    });

    expect(rounded.current.temp).toBe(293);
    expect(rounded.current.feels_like).toBe(295);
    expect(rounded.current.humidity).toBe(75);
    expect(rounded.current.dew_point).toBe(281);
    expect(rounded.daily[0].temp.day).toBe(293);
    expect(rounded.daily[0].temp.night).toBe(283);
    expect(rounded.humidity).toBe(60.4);
  });
});
