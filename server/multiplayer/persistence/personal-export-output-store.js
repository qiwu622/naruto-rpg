import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  canonicalStringify,
  canonicalizeJson,
  sha256Hex
} from '../domain/canonical-json.js';
import { DomainError } from '../domain/errors.js';

const HASH = /^sha256:([a-f0-9]{64})$/u;

function fail(code, message, details = {}, status = 500, cause = undefined) {
  throw new DomainError(code, message, details, { status, cause });
}

function hash(value) {
  return `sha256:${sha256Hex(canonicalStringify(value))}`;
}

function assertHash(value, label = 'output_hash') {
  const match = typeof value === 'string' ? value.match(HASH) : null;
  if (!match) fail('PERSONAL_EXPORT_OUTPUT_INVALID', `${label} is invalid`);
  return match[1];
}

function normalizeContent(value, expectedHash) {
  const content = canonicalizeJson(value);
  const actualHash = hash(content);
  if (actualHash !== expectedHash) {
    fail('PERSONAL_EXPORT_OUTPUT_HASH_MISMATCH', 'personal export content hash changed', {
      expected_output_hash: expectedHash,
      actual_output_hash: actualHash
    });
  }
  return content;
}

function parseStoredContent(bytes, expectedHash) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (error) {
    fail('PERSONAL_EXPORT_OUTPUT_CORRUPT', 'stored personal export is not JSON', {}, 500, error);
  }
  return normalizeContent(parsed, expectedHash);
}

export function createInMemoryPersonalExportOutputStore() {
  const values = new Map();
  return Object.freeze({
    async put({ output_hash, content }) {
      assertHash(output_hash);
      const normalized = normalizeContent(content, output_hash);
      const existing = values.get(output_hash);
      if (existing !== undefined
        && canonicalStringify(existing) !== canonicalStringify(normalized)) {
        fail('PERSONAL_EXPORT_OUTPUT_COLLISION', 'content-addressed output collision');
      }
      values.set(output_hash, normalized);
      return Object.freeze({ output_ref: output_hash });
    },

    async get({ output_ref }) {
      assertHash(output_ref, 'output_ref');
      const content = values.get(output_ref);
      if (content === undefined) {
        fail('PERSONAL_EXPORT_OUTPUT_NOT_FOUND', 'personal export output is missing', {}, 404);
      }
      return Object.freeze({
        output_hash: output_ref,
        content: canonicalizeJson(content)
      });
    },

    has(outputRef) {
      return values.has(outputRef);
    },

    size() {
      return values.size;
    }
  });
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fsp.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    // Some platforms do not allow fsync on directory descriptors. The file
    // itself is still fully synced before publication.
    if (!['EINVAL', 'EPERM', 'EISDIR'].includes(error?.code)) throw error;
  } finally {
    await handle?.close();
  }
}

/**
 * Immutable, content-addressed file store. Files are written and fsynced under
 * a private temporary name, then published with an atomic hard-link create.
 * A partial or failed write therefore never becomes an addressable output.
 */
export function createFilesystemPersonalExportOutputStore({ directory }) {
  if (typeof directory !== 'string' || !directory.trim()) {
    fail(
      'PERSONAL_EXPORT_OUTPUT_STORE_CONFIGURATION_INVALID',
      'personal export output directory is required'
    );
  }
  const root = path.resolve(directory);

  function filePath(outputHash) {
    const digest = assertHash(outputHash);
    return path.join(root, `${digest}.timeline.json`);
  }

  return Object.freeze({
    async put({ output_hash, content }) {
      assertHash(output_hash);
      const normalized = normalizeContent(content, output_hash);
      const bytes = Buffer.from(canonicalStringify(normalized), 'utf8');
      await fsp.mkdir(root, { recursive: true, mode: 0o700 });
      const destination = filePath(output_hash);
      const temporary = path.join(
        root,
        `.${output_hash.slice('sha256:'.length)}.${randomUUID()}.tmp`
      );
      let temporaryPresent = false;
      try {
        const handle = await fsp.open(temporary, 'wx', 0o600);
        temporaryPresent = true;
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await fsp.link(temporary, destination);
          await syncDirectory(root);
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error;
          const existing = await fsp.readFile(destination);
          parseStoredContent(existing, output_hash);
        }
      } catch (error) {
        if (error instanceof DomainError) throw error;
        fail(
          'PERSONAL_EXPORT_OUTPUT_STORE_FAILED',
          'personal export output could not be persisted',
          {},
          500,
          error
        );
      } finally {
        if (temporaryPresent) await fsp.unlink(temporary).catch(() => {});
      }
      return Object.freeze({ output_ref: output_hash });
    },

    async get({ output_ref }) {
      assertHash(output_ref, 'output_ref');
      let bytes;
      try {
        bytes = await fsp.readFile(filePath(output_ref));
      } catch (error) {
        if (error?.code === 'ENOENT') {
          fail('PERSONAL_EXPORT_OUTPUT_NOT_FOUND', 'personal export output is missing', {}, 404);
        }
        fail(
          'PERSONAL_EXPORT_OUTPUT_STORE_FAILED',
          'personal export output could not be read',
          {},
          500,
          error
        );
      }
      return Object.freeze({
        output_hash: output_ref,
        content: parseStoredContent(bytes, output_ref)
      });
    }
  });
}
