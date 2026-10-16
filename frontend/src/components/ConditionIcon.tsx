import type { ConditionCode } from '../lib/api';

/**
 * A weather condition as a small coloured picture (24×24): sun or moon, cloud, rain, lightning,
 * fog. Drawn from shared parts so the set stays consistent; colours come from CSS (.cond-*).
 */
const SUN = <g className="cond-sun"><circle cx="9" cy="9" r="3.6" /><path d="M9 2.2v1.6M9 14.2v1.6M2.2 9h1.6M14.2 9h1.6M4.2 4.2l1.1 1.1M12.7 12.7l1.1 1.1M4.2 13.8l1.1-1.1M12.7 5.3l1.1-1.1" /></g>;
const SUN_BIG = <g className="cond-sun"><circle cx="12" cy="12" r="4.4" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" /></g>;
const MOON = <path className="cond-moon" d="M13.5 9.6A5 5 0 0 1 7.9 4a5 5 0 1 0 5.6 5.6Z" />;
const MOON_BIG = <path className="cond-moon" d="M19 14.2A7.4 7.4 0 0 1 9.8 5a7.4 7.4 0 1 0 9.2 9.2Z" />;
const CLOUD = <path className="cond-cloud" d="M8 19h9.5a3.8 3.8 0 0 0 .4-7.6A5.6 5.6 0 0 0 7.2 11 4 4 0 0 0 8 19Z" />;
const CLOUD_HIGH = <path className="cond-cloud" d="M8 15h9.5a3.6 3.6 0 0 0 .4-7.2A5.3 5.3 0 0 0 7.4 7.4 3.8 3.8 0 0 0 8 15Z" />;
const CLOUD_BACK = <path className="cond-cloud cond-cloud--back" d="M15.5 6.5a4.2 4.2 0 0 0-7.6 1.4" />;
const DROPS = (n: number) => (
  <g className="cond-rain">
    {[9, 12.5, 16].slice(0, n).map((x) => <path key={x} d={`M${x} 17.5l-1 3`} />)}
  </g>
);
const BOLT = <path className="cond-bolt" d="M12.8 15.5 10.5 19h3l-1.8 3.5" />;
const FOG = <g className="cond-cloud"><path d="M4 9h16M6 13h12M4 17h16" /></g>;

export function ConditionIcon({ code, night = false, size = 24, title }: { code: ConditionCode; night?: boolean; size?: number; title?: string }) {
  const body = (() => {
    switch (code) {
      case 'clear': return night ? MOON_BIG : SUN_BIG;
      case 'mostly_clear': return <>{night ? MOON : SUN}<path className="cond-cloud" d="M11 20h7a3 3 0 0 0 .3-6 4.3 4.3 0 0 0-8.3.9A2.6 2.6 0 0 0 11 20Z" /></>;
      case 'partly_cloudy': return <>{night ? MOON : SUN}{CLOUD}</>;
      case 'mostly_cloudy': return <>{CLOUD_BACK}{CLOUD}</>;
      case 'cloudy': return <>{CLOUD_BACK}{CLOUD}</>;
      case 'fog': return FOG;
      case 'drizzle': return <>{CLOUD_HIGH}{DROPS(2)}</>;
      case 'rain': return <>{CLOUD_HIGH}{DROPS(3)}</>;
      case 'heavy_rain': return <>{CLOUD_HIGH}<g className="cond-rain cond-rain--heavy"><path d="M8 17l-1.4 4M11.5 17l-1.4 4M15 17l-1.4 4M18.5 17l-1.4 4" /></g></>;
      case 'thunderstorm': return <>{CLOUD_HIGH}{BOLT}<g className="cond-rain"><path d="M8.5 17.5l-1 3M17 17.5l-1 3" /></g></>;
    }
  })();
  return (
    <svg className="cond-icon" viewBox="0 0 24 24" width={size} height={size} role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      {body}
    </svg>
  );
}
