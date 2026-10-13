/**
 * iOS ignores the manifest for launch screens: it needs one <link rel="apple-touch-startup-image">
 * per screen size (portrait, CSS px × device pixel ratio). Rendered by app/splash/[spec].
 */
const DEVICES: [w: number, h: number, dpr: number][] = [
  [440, 956, 3], // iPhone 16/17 Pro Max
  [420, 912, 3], // iPhone Air
  [402, 874, 3], // iPhone 16/17 Pro, 17
  [430, 932, 3], // iPhone 14/15 Pro Max, 15/16 Plus
  [393, 852, 3], // iPhone 14/15 Pro, 15, 16, 16e
  [428, 926, 3], // iPhone 12/13 Pro Max, 14 Plus
  [390, 844, 3], // iPhone 12/13/14, 12/13 Pro
  [375, 812, 3], // iPhone X/XS/11 Pro, 12/13 mini
  [414, 896, 3], // iPhone XS Max, 11 Pro Max
  [414, 896, 2], // iPhone XR, 11
  [414, 736, 3], // iPhone 6/7/8 Plus
  [375, 667, 2], // iPhone 6/7/8, SE 2nd/3rd gen
  [320, 568, 2], // iPhone SE 1st gen
  [1032, 1376, 2], // iPad Pro 13" (M4)
  [1024, 1366, 2], // iPad Pro 12.9"
  [834, 1210, 2], // iPad Pro 11" (M4)
  [834, 1194, 2], // iPad Pro 11"
  [820, 1180, 2], // iPad Air 10.9", iPad 10th gen
  [834, 1112, 2], // iPad Air 10.5"
  [810, 1080, 2], // iPad 10.2"
  [768, 1024, 2], // iPad mini 5, iPad 9.7"
  [744, 1133, 2], // iPad mini 6/7
];

export type SplashTheme = 'light' | 'dark';

/** background colours match --color-bg-canvas in each theme */
export const SPLASH_BG: Record<SplashTheme, string> = { light: '#f4f7fa', dark: '#181d25' };

export interface SplashSpec {
  id: string;
  width: number;
  height: number;
  theme: SplashTheme;
  media: string;
}

export const SPLASH_SPECS: SplashSpec[] = DEVICES.flatMap(([w, h, dpr]) =>
  (['light', 'dark'] as const).map((theme) => ({
    id: `${w}x${h}@${dpr}-${theme}`,
    width: w * dpr,
    height: h * dpr,
    theme,
    media:
      `(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${dpr}) ` +
      `and (orientation: portrait) and (prefers-color-scheme: ${theme})`,
  })),
);
