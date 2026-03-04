import { z } from 'zod';

export const SummaryBlockSchema = z.object({
  id: z.string(),
  depth: z.number(),
  kind: z.enum(['leaf', 'condensed']),
  msgRange: z.object({
    earliest: z.number(),
    latest: z.number(),
  }),
  childCount: z.number(),
  content: z.string(),
});

export type SummaryBlock = z.infer<typeof SummaryBlockSchema>;

export const GrepResultSetSchema = z.object({
  results: z.array(
    z.object({
      kind: z.enum(['message', 'summary']),
      id: z.string(),
      snippet: z.string(),
    }),
  ),
  error: z.string().optional(),
});

export type GrepResultSet = z.infer<typeof GrepResultSetSchema>;

const DescribeSuccessSchema = z.object({
  summaryId: z.string(),
  depth: z.number(),
  kind: z.enum(['leaf', 'condensed']),
  tokenCount: z.number(),
  earliestAt: z.number(),
  latestAt: z.number(),
  descendantCount: z.number(),
  childIds: z.array(z.string()),
});

const DescribeErrorSchema = z.object({
  error: z.string(),
  id: z.string(),
});

export const DescribeResultSchema = z.union([DescribeSuccessSchema, DescribeErrorSchema]);

export type DescribeResult = z.infer<typeof DescribeResultSchema>;

const ExpandSuccessSchema = z.object({
  id: z.string(),
  source: z.enum(['dag', 'session']),
  content: z.string(),
});

const ExpandErrorSchema = z.object({
  error: z.string(),
  id: z.string(),
});

export const ExpandResultSchema = z.union([ExpandSuccessSchema, ExpandErrorSchema]);

export type ExpandResult = z.infer<typeof ExpandResultSchema>;
