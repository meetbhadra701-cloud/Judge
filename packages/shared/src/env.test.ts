import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BaseEnv, ConfigError, parseEnv } from './env.js';

describe('parseEnv', () => {
  it('applies defaults and treats empty strings as unset', () => {
    expect(parseEnv(BaseEnv, { LOG_LEVEL: '' })).toEqual({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
    });
  });

  it('rejects invalid values with a ConfigError that never echoes the supplied value', () => {
    const schema = BaseEnv.extend({ PORT: z.coerce.number().int().min(1).max(65535) });
    const secretLookingValue = 'postgres://user:hunter2@db/prod';

    let caught: unknown;
    try {
      parseEnv(schema, { NODE_ENV: secretLookingValue, PORT: '70000' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    const configError = caught as ConfigError;
    expect(configError.issues.map((issue) => issue.split(':')[0])).toEqual(['NODE_ENV', 'PORT']);
    expect(configError.message).not.toContain('hunter2');
  });
});
