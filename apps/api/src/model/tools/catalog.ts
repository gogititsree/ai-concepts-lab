import type { CatalogToolName } from '@lab/shared';
import { and, eq, ilike, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import { lessons, modules } from '../../db/schema.js';
import { CalculatorError, evaluateExpression } from './calculator.js';
import { defineTool, ToolError, type ToolSpec } from './types.js';

/**
 * The server-side tool catalog (docs/01-architecture.md → "The agent loop").
 *
 * Every description in this file is a prompt. They are written to the rules Module 5's
 * second lesson teaches — say what the tool does, say *when* to reach for it, and show
 * one concrete argument — because on an 8B model that wording is the difference between
 * an agent that uses its calculator and one that guesses at arithmetic. The measured
 * effect is in `docs/spike-notes.md` under "M10 measurements".
 *
 * Nothing here reaches outside the process except `lookup_glossary`, which reads this
 * app's own seeded lessons. That is deliberate: the tools a learner can attach to a run
 * are a closed set with no network, no filesystem and no shell, so the interesting
 * failures in Module 5 are the *agent's* failures rather than an outage somewhere else.
 */

// ------------------------------------------------------------------ calculator ----

const calculator = defineTool({
  name: 'calculator',
  description:
    'Evaluate an arithmetic expression exactly. Use this for EVERY calculation, including ' +
    'ones that look easy - do not do arithmetic in your head. Supports + - * / % and ^ for ' +
    'powers, with parentheses. Example: {"expression": "2500 * 1.07^8"}. Returns the numeric ' +
    'result.',
  schema: z.object({
    expression: z
      .string()
      .min(1)
      .max(500)
      .describe('An arithmetic expression, e.g. "2500 * 1.07^8". Numbers and operators only.'),
  }),
  execute({ expression }) {
    try {
      const result = evaluateExpression(expression);
      return { expression, result };
    } catch (error) {
      if (error instanceof CalculatorError) throw new ToolError(error.message, 'CALCULATOR_ERROR');
      throw error;
    }
  },
});

// ------------------------------------------------------------ get_current_time ----

/**
 * A short allow-list rather than "any IANA zone".
 *
 * An `enum` in the schema is the single most reliable way to get a small model to supply
 * a valid value (Module 5, lesson 2), and an open string field would mostly produce
 * `"EST"`, `"GMT+1"` and `"Pacific Time"` — none of which `Intl` accepts. The tool still
 * validates against `Intl` before formatting, because the allow-list is a usability
 * measure and the validation is the correctness one.
 */
const TIME_ZONES = [
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
] as const;

/** Reads one formatted part out of `Intl`, which returns them as a list, not an object. */
function parts(date: Date, timeZone: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const out: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) out[part.type] = part.value;
  return out;
}

const getCurrentTime = defineTool({
  name: 'get_current_time',
  description:
    'Get the current date and time. You do not know the date; you must call this tool ' +
    'before answering any question about today, now, the current day of the week, or how ' +
    'long until something. Example: {"timezone": "Europe/London"}. Defaults to UTC.',
  schema: z.object({
    timezone: z
      .enum(TIME_ZONES)
      .default('UTC')
      .describe('IANA timezone name. Use UTC unless the question names a place.'),
  }),
  execute({ timezone }, ctx) {
    const now = ctx.now();
    let field: Record<string, string>;
    try {
      field = parts(now, timezone);
    } catch {
      throw new ToolError(`"${timezone}" is not a timezone this server recognises`);
    }
    return {
      iso: now.toISOString(),
      timezone,
      weekday: field.weekday ?? '',
      date: `${field.year}-${field.month}-${field.day}`,
      time: `${field.hour}:${field.minute}:${field.second}`,
      unixSeconds: Math.floor(now.getTime() / 1000),
    };
  },
});

// ---------------------------------------------------------------- unit_convert ----

/**
 * Conversions as (factor to a base unit) per dimension, plus temperature as a special
 * case because it is affine rather than linear — 0 °C is not 0 °F, so a multiplier
 * cannot express it. Writing that out is one of the small honest details the lesson on
 * tool schemas points at: the *schema* cannot tell you kelvin and celsius are related
 * differently from metres and feet, only the implementation can.
 */
const UNITS = {
  // length, base metre
  m: { dimension: 'length', factor: 1 },
  km: { dimension: 'length', factor: 1000 },
  cm: { dimension: 'length', factor: 0.01 },
  mm: { dimension: 'length', factor: 0.001 },
  mi: { dimension: 'length', factor: 1609.344 },
  yd: { dimension: 'length', factor: 0.9144 },
  ft: { dimension: 'length', factor: 0.3048 },
  in: { dimension: 'length', factor: 0.0254 },
  // mass, base kilogram
  kg: { dimension: 'mass', factor: 1 },
  g: { dimension: 'mass', factor: 0.001 },
  mg: { dimension: 'mass', factor: 0.000001 },
  lb: { dimension: 'mass', factor: 0.45359237 },
  oz: { dimension: 'mass', factor: 0.028349523125 },
  // time, base second
  s: { dimension: 'time', factor: 1 },
  min: { dimension: 'time', factor: 60 },
  h: { dimension: 'time', factor: 3600 },
  day: { dimension: 'time', factor: 86400 },
  // temperature, handled separately
  c: { dimension: 'temperature', factor: 1 },
  f: { dimension: 'temperature', factor: 1 },
  k: { dimension: 'temperature', factor: 1 },
} as const satisfies Record<string, { dimension: string; factor: number }>;

const UNIT_NAMES = Object.keys(UNITS) as [keyof typeof UNITS, ...(keyof typeof UNITS)[]];

const toCelsius = (value: number, from: string): number =>
  from === 'c' ? value : from === 'f' ? ((value - 32) * 5) / 9 : value - 273.15;

const fromCelsius = (value: number, to: string): number =>
  to === 'c' ? value : to === 'f' ? (value * 9) / 5 + 32 : value + 273.15;

const unitConvert = defineTool({
  name: 'unit_convert',
  description:
    'Convert a quantity between units of the same kind (length, mass, time or ' +
    'temperature). Example: {"value": 26.2, "from": "mi", "to": "km"}. Temperature units ' +
    'are "c", "f" and "k". Returns the converted value.',
  schema: z.object({
    value: z.number().finite().describe('The quantity to convert.'),
    from: z.enum(UNIT_NAMES).describe('The unit the value is currently in.'),
    to: z.enum(UNIT_NAMES).describe('The unit to convert to. Must be the same kind as "from".'),
  }),
  execute({ value, from, to }) {
    const source = UNITS[from];
    const target = UNITS[to];
    if (source.dimension !== target.dimension) {
      throw new ToolError(
        `cannot convert ${source.dimension} ("${from}") to ${target.dimension} ("${to}")`,
      );
    }
    const result =
      source.dimension === 'temperature'
        ? fromCelsius(toCelsius(value, from), to)
        : (value * source.factor) / target.factor;
    // Rounded to 10 significant figures: floating-point noise like 42.16000000000001 in a
    // tool result is something the model will faithfully copy into its answer.
    return { value, from, to, result: Number(result.toPrecision(10)) };
  },
});

// -------------------------------------------------------------- lookup_glossary ----

/** Matches around a hit so the model gets context, not a whole 900-word lesson. */
const SNIPPET_RADIUS = 220;

function snippet(body: string, term: string): string {
  const index = body.toLowerCase().indexOf(term.toLowerCase());
  if (index === -1) return body.slice(0, SNIPPET_RADIUS * 2).trim();
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(body.length, index + term.length + SNIPPET_RADIUS);
  return `${start > 0 ? '…' : ''}${body.slice(start, end).trim()}${end < body.length ? '…' : ''}`;
}

/**
 * The tool that makes the agent part of *this* app.
 *
 * It searches the lessons the learner has been reading, in the same Postgres the rest of
 * the app uses, and returns module/lesson slugs the answer can cite. An agent that can
 * quote the course back at you feels categorically different from one with a calculator,
 * and it costs one `ILIKE` query.
 */
const lookupGlossary = defineTool({
  name: 'lookup_glossary',
  description:
    'Search the AI Concepts Lab course content for a term and get the passages that ' +
    'explain it, with the lesson they came from. Use this for any question about what a ' +
    'concept means in this course. Example: {"term": "backpropagation"}.',
  schema: z.object({
    term: z
      .string()
      .min(2)
      .max(64)
      .describe('A single concept to look up, e.g. "attention" or "system prompt".'),
  }),
  async execute({ term }, ctx) {
    // `%` and `_` are ILIKE wildcards; a term containing one would silently widen the
    // search rather than fail, which is the confusing kind of bug.
    const pattern = `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    const rows = await ctx.db
      .select({
        moduleSlug: modules.slug,
        moduleTitle: modules.title,
        lessonSlug: lessons.slug,
        lessonTitle: lessons.title,
        bodyMd: lessons.bodyMd,
      })
      .from(lessons)
      .innerJoin(modules, eq(lessons.moduleId, modules.id))
      .where(
        and(
          eq(modules.isPublished, true),
          or(ilike(lessons.bodyMd, pattern), ilike(lessons.title, pattern)),
        ),
      )
      // Title hits first: a lesson called "Attention" is a better answer about attention
      // than a lesson that mentions it once in passing.
      .orderBy(
        sql`case when ${ilike(lessons.title, pattern)} then 0 else 1 end`,
        modules.orderIndex,
        lessons.orderIndex,
      )
      .limit(3);

    if (rows.length === 0) {
      return { term, matches: [], note: `No lesson in this course mentions "${term}".` };
    }
    return {
      term,
      matches: rows.map((row) => ({
        module: row.moduleSlug,
        lesson: row.lessonSlug,
        title: row.lessonTitle,
        excerpt: snippet(row.bodyMd, term),
      })),
    };
  },
});

// ---------------------------------------------------------------- fake_weather ----

const CONDITIONS = ['clear', 'light cloud', 'overcast', 'light rain', 'heavy rain', 'snow'];

/** FNV-1a: stable across processes, so a trace in a lesson matches what a learner sees. */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value = Math.imul(value ^ text.charCodeAt(index), 0x01000193) >>> 0;
  }
  return value;
}

const fakeWeather = defineTool({
  name: 'fake_weather',
  description:
    'Get a FAKE weather report for a place. The data is invented by this server and is ' +
    'not real weather; say so if you use it. Example: {"location": "Lisbon"}. Exists so ' +
    'you can practise calling a tool that returns structured data.',
  schema: z.object({
    location: z.string().min(1).max(80).describe('A city or place name.'),
    day: z.enum(['today', 'tomorrow']).default('today').describe('Which day to report on.'),
  }),
  execute({ location, day }) {
    const seed = hash(`${location.trim().toLowerCase()}|${day}`);
    return {
      location,
      day,
      temperatureC: (seed % 35) - 5,
      condition: CONDITIONS[seed % CONDITIONS.length],
      windKph: seed % 40,
      source: 'fake_weather: invented, deterministic, not real weather data',
    };
  },
});

// --------------------------------------------------------------- flaky_service ----

/**
 * The tool that always breaks, on purpose.
 *
 * Module 5's `observe-failure` task needs a learner to watch the loop handle a failing
 * tool, and the alternatives were worse: breaking a real tool would make the other three
 * tasks flaky, and a mock tool returning `{"error": ...}` teaches the wrong thing — that
 * is a *successful* call that happens to return the word "error", which is exactly the
 * distinction the trace viewer draws with `is_error`.
 *
 * It is a deviation from the five-tool catalog in docs/01-architecture.md; the reason is
 * in the report and in lesson 4.
 */
const flakyService = defineTool({
  name: 'flaky_service',
  description:
    'A deliberately broken service used to demonstrate error handling. It always fails. ' +
    'Call it once if asked to, then explain what happened instead of retrying forever.',
  schema: z.object({
    query: z.string().max(200).default('').describe('Anything; it will fail regardless.'),
  }),
  execute() {
    throw new ToolError(
      'flaky_service is unavailable (503): upstream connection reset. This tool always fails.',
      'UPSTREAM_UNAVAILABLE',
    );
  },
});

// -------------------------------------------------------------------- the map ----

export const TOOL_CATALOG: Record<CatalogToolName, ToolSpec> = {
  calculator,
  get_current_time: getCurrentTime,
  unit_convert: unitConvert,
  lookup_glossary: lookupGlossary,
  fake_weather: fakeWeather,
  flaky_service: flakyService,
};

export const catalogTool = (name: CatalogToolName): ToolSpec => TOOL_CATALOG[name];
