import { z } from 'zod';

export const speedSchema = z.enum(['inherit', 'standard', 'fast']);
export type Speed = z.infer<typeof speedSchema>;

export function speedConfig(speed: Speed = 'inherit') {
  if (speed === 'inherit') return undefined;
  return {
    service_tier: speed === 'fast' ? 'fast' : 'default',
    features: { fast_mode: speed === 'fast' },
  };
}

// -- protects literal requirement text from option parsing.
export function parseSpeedArgs(input: string[]): { args: string[]; speed?: Speed } {
  const args: string[] = [];
  let speed: Speed | undefined;
  let literal = false;
  for (const value of input) {
    if (!literal && value === '--') {
      literal = true;
      continue;
    }
    if (!literal && (value === '--fast' || value === '--no-fast')) {
      const selected = value === '--fast' ? 'fast' : 'standard';
      if (speed && speed !== selected) throw new Error('--fast 与 --no-fast 不能同时使用');
      speed = selected;
    } else args.push(value);
  }
  return { args, speed };
}

// Chat flags precede the requirement (after the workflow ID when present).
export function parseSpeedText(text: string): { text: string; speed?: Speed } {
  let rest = text.trim();
  const flags: string[] = [];
  while (/^(--fast|--no-fast)(?:\s|$)/.test(rest)) {
    const match = /^(\S+)\s*([\s\S]*)$/.exec(rest)!;
    flags.push(match[1]!);
    rest = match[2]!;
  }
  if (rest === '--') rest = '';
  else if (rest.startsWith('-- ')) rest = rest.slice(3);
  return { text: rest, speed: parseSpeedArgs(flags).speed };
}
