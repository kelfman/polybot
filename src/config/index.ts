import { z } from 'zod';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Schema for strategy parameters
const StrategySchema = z.object({
  name: z.string(),
  entryPriceMin: z.number().min(0).max(1),
  entryPriceMax: z.number().min(0).max(1),
  exitPriceTarget: z.number().min(0).max(1),
  timeToResolutionDaysMin: z.number().positive(),
  timeToResolutionDaysMax: z.number().positive(),
  holdToResolution: z.boolean().optional().default(false), // If true, ignore exitPriceTarget and hold to resolution
  maxVolatility: z.enum(['low', 'medium', 'high']).optional().default('high'), // Filter out markets above this volatility level
});

// Schema for volatility classification
const VolatilityClassificationSchema = z.object({
  enabled: z.boolean(),
  highVolatilityThreshold: z.number().positive(), // % swing to classify as high volatility
  swingCountThreshold: z.number().int().positive(), // Number of swings to classify as high volatility
});

// Schema for LLM convergence classification
const LLMConvergenceClassificationSchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(['openai', 'anthropic']),
  model: z.string(),
  cacheResults: z.boolean(),
});

// Schema for all classifications
const ClassificationSchema = z.object({
  volatility: VolatilityClassificationSchema,
  llmConvergence: LLMConvergenceClassificationSchema,
});

// Schema for risk management
const RiskSchema = z.object({
  positionSizeUsd: z.number().positive(),
  maxPositions: z.number().int().positive(),
  maxExposureUsd: z.number().positive(),
  stopLossPercent: z.number().min(0).max(100).nullable(),
});

// Schema for backtest settings
const BacktestSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
});

// Schema for data source configuration
const DataSourceSchema = z.object({
  primary: z.enum(['gamma', 'csv', 'kaggle', 'kaggle-ndjson']),
  fallback: z.enum(['gamma', 'csv', 'kaggle', 'kaggle-ndjson', 'none']),
  csvPath: z.string(),
});

// Complete config schema
const ConfigSchema = z.object({
  strategy: StrategySchema,
  classification: ClassificationSchema,
  risk: RiskSchema,
  backtest: BacktestSchema,
  dataSource: DataSourceSchema,
});

export type Config = z.infer<typeof ConfigSchema>;
export type StrategyConfig = z.infer<typeof StrategySchema>;
export type ClassificationConfig = z.infer<typeof ClassificationSchema>;
export type VolatilityClassificationConfig = z.infer<typeof VolatilityClassificationSchema>;
export type LLMConvergenceClassificationConfig = z.infer<typeof LLMConvergenceClassificationSchema>;
export type RiskConfig = z.infer<typeof RiskSchema>;
export type BacktestConfig = z.infer<typeof BacktestSchema>;
export type DataSourceConfig = z.infer<typeof DataSourceSchema>;

let cachedConfig: Config | null = null;

/**
 * Load and validate configuration from config.json
 * @param configPath Path to config file (defaults to project root config.json)
 * @returns Validated configuration object
 * @throws Error if config is invalid or missing
 */
export function loadConfig(configPath?: string): Config {
  if (cachedConfig && !configPath) {
    return cachedConfig;
  }

  const path = configPath || resolve(process.cwd(), 'config.json');
  
  let rawConfig: unknown;
  try {
    const content = readFileSync(path, 'utf-8');
    rawConfig = JSON.parse(content);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`Config file not found: ${path}`);
    }
    throw new Error(`Failed to parse config file: ${error}`);
  }

  const result = ConfigSchema.safeParse(rawConfig);
  
  if (!result.success) {
    const errors = result.error.issues
      .map(issue => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${errors}`);
  }

  // Validate logical constraints
  const config = result.data;
  
  if (config.strategy.entryPriceMin >= config.strategy.entryPriceMax) {
    throw new Error('entryPriceMin must be less than entryPriceMax');
  }
  
  if (config.strategy.entryPriceMax >= config.strategy.exitPriceTarget) {
    throw new Error('entryPriceMax must be less than exitPriceTarget');
  }
  
  if (config.strategy.timeToResolutionDaysMin >= config.strategy.timeToResolutionDaysMax) {
    throw new Error('timeToResolutionDaysMin must be less than timeToResolutionDaysMax');
  }

  if (!configPath) {
    cachedConfig = config;
  }
  
  return config;
}

/**
 * Get cached config or load it
 */
export function getConfig(): Config {
  return loadConfig();
}

/**
 * Clear cached config (useful for testing)
 */
export function clearConfigCache(): void {
  cachedConfig = null;
}
