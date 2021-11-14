import * as t from '@babel/types';
import generate from '@babel/generator';
import { ResolveConfigOptions, format, resolveConfig } from 'prettier';
import { parse } from 'groq-js';

import { transformGroqToStructure } from './transform-groq-to-structure';
import { transformStructureToTs } from './transform-structure-to-ts';
import {
  pluckGroqFromFiles,
  PluckGroqFromFilesOptions,
} from './pluck-groq-from-files';
import { simpleLogger } from './utils';

export interface GenerateGroqTypesOptions extends PluckGroqFromFilesOptions {
  /**
   * This option is fed directly to prettier `resolveConfig`
   *
   * https://prettier.io/docs/en/api.html#prettierresolveconfigfilepath--options
   */
  prettierResolveConfigPath?: string;
  /**
   * This options is also fed directly to prettier `resolveConfig`
   *
   * https://prettier.io/docs/en/api.html#prettierresolveconfigfilepath--options
   */
  prettierResolveConfigOptions?: ResolveConfigOptions;
  /**
   * An extracted and normalized schema result from the
   * `@sanity-codegen/schema-codegen` package.
   */
  normalizedSchema: Sanity.SchemaDef.Schema;
}

/**
 * Given a selection of filenames, this will pluck matching GROQ queries
 * (@see `pluckGroqFromFiles`) and then run them through a GROQ-to-TypeScript
 * transform.
 *
 * The result of each plucked query is put together into one source string.
 */
export async function generateGroqTypes({
  prettierResolveConfigOptions,
  prettierResolveConfigPath,
  normalizedSchema,
  ...pluckOptions
}: GenerateGroqTypesOptions) {
  const { logger = simpleLogger } = pluckOptions;
  const extractedQueries = await pluckGroqFromFiles(pluckOptions);

  logger.verbose('Converting queries to typescript…');
  let progress = 0;

  const { queries, references } = extractedQueries
    .map(({ queryKey, query }) => {
      progress += 1;
      logger.verbose(
        `Converting queries to typescript… ${Math.round(
          (progress * 100) / extractedQueries.length,
        )}% (${progress}/${extractedQueries.length})`,
      );

      // TODO: should this be async?
      const structure = transformGroqToStructure({
        node: parse(query),
        scopes: [],
        normalizedSchema,
      });

      return { queryKey, ...transformStructureToTs({ structure }) };
    })
    .reduce<{
      queries: { [queryKey: string]: t.TSType };
      references: { [referenceKey: string]: t.TSType };
    }>(
      (acc, { queryKey, query, references }) => {
        acc.queries[queryKey] = query;

        for (const [key, value] of Object.entries(references)) {
          acc.references[key] = value;
        }

        return acc;
      },
      { queries: {}, references: {} },
    );
  const queryCount = Object.keys(queries).length;

  logger[queryCount === 1 ? 'warn' : 'success'](
    `Converted ${queryCount} ${
      queryCount === 1 ? 'query' : 'queries'
    } to TypeScript`,
  );

  const finalCodegen = `
    /// <reference types="@sanity-codegen/types" />

    declare namespace Sanity {
      namespace Queries {
        ${Object.entries(queries)
          .sort(([queryKeyA], [queryKeyB]) =>
            queryKeyA.localeCompare(queryKeyB, 'en'),
          )
          .map(
            ([queryKey, queryTsType]) =>
              `type ${queryKey} = ${generate(queryTsType).code}`,
          )
          .join('\n')}

          ${Object.entries(references)
            .sort(([referenceKeyA], [referenceKeyB]) =>
              referenceKeyA.localeCompare(referenceKeyB, 'en'),
            )
            .map(
              ([referenceKey, referenceTsType]) =>
                `type ${referenceKey} = ${generate(referenceTsType).code}`,
            )
            .join('\n')}

        /**
         * A keyed type of all the codegen'ed queries. This type is used for
         * TypeScript meta programming purposes only.
         */
        type QueryMap = {
          ${Object.keys(queries)
            .map((queryKey) => `${queryKey}: ${queryKey};`)
            .join('\n')}
        };
      }
    }
  `;

  const resolvedConfig = prettierResolveConfigPath
    ? await resolveConfig(
        prettierResolveConfigPath,
        prettierResolveConfigOptions,
      )
    : null;

  return format(finalCodegen, {
    ...resolvedConfig,
    parser: 'typescript',
  });
}