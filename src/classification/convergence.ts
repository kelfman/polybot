/**
 * LLM Convergence Classification
 * Uses an LLM to classify market questions as having natural convergence vs uncertain outcomes
 */

import { getConfig, type LLMConvergenceClassificationConfig } from '../config/index.js';
import type { ConvergenceType } from './types.js';

/**
 * Convergence classification result
 */
export interface ConvergenceClassification {
  type: ConvergenceType;
  confidence: number;
  reasoning: string;
}

/**
 * Cache for LLM classifications to avoid repeated API calls
 */
const classificationCache = new Map<string, ConvergenceClassification>();

/**
 * System prompt for the LLM
 */
const SYSTEM_PROMPT = `You are an expert at analyzing prediction market questions.

Your task is to classify whether a market question has NATURAL CONVERGENCE properties or UNCERTAIN outcomes.

NATURAL CONVERGENCE markets:
- Have objectively measurable outcomes (price targets, scores, deadlines)
- The answer becomes increasingly clear as the deadline approaches
- Examples: "Will BTC reach $100k by Dec 31?", "Will Team A beat Team B?", "Will inflation be below 3% in Q4?"

UNCERTAIN OUTCOME markets:
- Depend on human decisions that can go either way until the last moment
- The answer is not predictable from observable trends
- Examples: "Will the judge rule in favor of X?", "Will Congress pass bill Y?", "Will CEO resign?"

Respond with JSON only:
{
  "convergenceType": "natural" | "uncertain" | "unknown",
  "confidence": 0.0-1.0,
  "reasoning": "Brief explanation"
}`;

/**
 * Call OpenAI API for classification
 */
async function classifyWithOpenAI(
  question: string,
  model: string
): Promise<ConvergenceClassification> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      type: 'unknown',
      confidence: 0,
      reasoning: 'OPENAI_API_KEY not set',
    };
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Classify this market question:\n\n"${question}"` },
        ],
        temperature: 0.1,
        max_tokens: 200,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error('No response from OpenAI');
    }

    const parsed = JSON.parse(content);
    return {
      type: parsed.convergenceType as ConvergenceType,
      confidence: parsed.confidence || 0.5,
      reasoning: parsed.reasoning || 'No reasoning provided',
    };
  } catch (error) {
    console.error('OpenAI classification error:', error);
    return {
      type: 'unknown',
      confidence: 0,
      reasoning: `Error: ${error}`,
    };
  }
}

/**
 * Call Anthropic API for classification
 */
async function classifyWithAnthropic(
  question: string,
  model: string
): Promise<ConvergenceClassification> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      type: 'unknown',
      confidence: 0,
      reasoning: 'ANTHROPIC_API_KEY not set',
    };
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 200,
        system: SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: `Classify this market question:\n\n"${question}"` },
        ],
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    const content = data.content?.[0]?.text;

    if (!content) {
      throw new Error('No response from Anthropic');
    }

    const parsed = JSON.parse(content);
    return {
      type: parsed.convergenceType as ConvergenceType,
      confidence: parsed.confidence || 0.5,
      reasoning: parsed.reasoning || 'No reasoning provided',
    };
  } catch (error) {
    console.error('Anthropic classification error:', error);
    return {
      type: 'unknown',
      confidence: 0,
      reasoning: `Error: ${error}`,
    };
  }
}

/**
 * Classify a market question using LLM
 */
export async function classifyConvergence(
  question: string,
  config?: LLMConvergenceClassificationConfig
): Promise<ConvergenceClassification> {
  const classConfig = config || getConfig().classification.llmConvergence;
  
  if (!classConfig.enabled) {
    return {
      type: 'unknown',
      confidence: 0,
      reasoning: 'LLM classification disabled',
    };
  }

  // Check cache first
  if (classConfig.cacheResults && classificationCache.has(question)) {
    return classificationCache.get(question)!;
  }

  let classification: ConvergenceClassification;

  if (classConfig.provider === 'openai') {
    classification = await classifyWithOpenAI(question, classConfig.model);
  } else if (classConfig.provider === 'anthropic') {
    classification = await classifyWithAnthropic(question, classConfig.model);
  } else {
    classification = {
      type: 'unknown',
      confidence: 0,
      reasoning: `Unknown provider: ${classConfig.provider}`,
    };
  }

  // Cache result
  if (classConfig.cacheResults) {
    classificationCache.set(question, classification);
  }

  return classification;
}

/**
 * Clear the classification cache
 */
export function clearClassificationCache(): void {
  classificationCache.clear();
}

/**
 * Get cache statistics
 */
export function getCacheStats(): { size: number; entries: string[] } {
  return {
    size: classificationCache.size,
    entries: Array.from(classificationCache.keys()),
  };
}

/**
 * Get a human-readable description of convergence type
 */
export function describeConvergence(type: ConvergenceType): string {
  switch (type) {
    case 'natural':
      return 'Natural convergence - outcome becomes clearer over time';
    case 'uncertain':
      return 'Uncertain outcome - depends on unpredictable decisions';
    case 'unknown':
      return 'Unknown - not classified';
  }
}

