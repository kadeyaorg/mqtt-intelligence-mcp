/**
 * The decoder contract, which is the whole of this feature.
 *
 * A decoder is third-party code running on bytes an attacker may have chosen, inside the
 * ingest flush. The clauses that matter are not "it decodes" — they are what happens when it
 * declines, when it throws, and when it is no longer there.
 */
import { describe, expect, it } from 'vitest';
import type { PayloadDecoder } from '../../src/index.js';
import { runDecoders, toPayloadView } from '../../src/index.js';

/** Reads a payload that starts with a marker byte, as a framed format would. */
const marker: PayloadDecoder = {
  name: 'marker',
  decode(payload) {
    if (payload[0] !== 0x7f) {
      return undefined;
    }
    return { value: payload[1] ?? 0, token: 'hunter2' };
  },
};

const always: PayloadDecoder = {
  name: 'always',
  decode: () => ({ claimed: true }),
};

const broken: PayloadDecoder = {
  name: 'broken',
  decode() {
    throw new Error('decoder is wrong, payload is not');
  },
};

describe('offering a payload to decoders', () => {
  it('takes the first claim and names the decoder that made it', () => {
    const result = runDecoders(new Uint8Array([0x7f, 42]), { topic: 'a' }, [marker, always]);

    expect(result.outcome).toEqual({ value: { value: 42, token: 'hunter2' }, decoder: 'marker' });
    expect(result.failures).toEqual([]);
  });

  it('moves on when a decoder declines, which is how a list of them works', () => {
    const result = runDecoders(new Uint8Array([0x01]), { topic: 'a' }, [marker, always]);

    expect(result.outcome?.decoder).toBe('always');
  });

  it('carries on past a decoder that throws, and reports which one', () => {
    // One broken extension must not take a namespace's ingestion with it.
    const result = runDecoders(new Uint8Array([0x7f, 7]), { topic: 'a' }, [broken, marker]);

    expect(result.outcome?.decoder).toBe('marker');
    expect(result.failures.map((failure) => failure.decoder)).toEqual(['broken']);
  });

  it('returns nothing when every decoder declines', () => {
    const result = runDecoders(new Uint8Array([0x01]), { topic: 'a' }, [marker]);

    expect(result.outcome).toBeUndefined();
  });

  it('passes the topic and the publisher content type, which formats key off', () => {
    const seen: unknown[] = [];
    const spy: PayloadDecoder = {
      name: 'spy',
      decode: (_payload, context) => {
        seen.push(context);
        return { ok: true };
      },
    };

    runDecoders(new Uint8Array([1]), { topic: 'plc/state', contentType: 'application/x-foo' }, [
      spy,
    ]);

    expect(seen[0]).toEqual({ topic: 'plc/state', contentType: 'application/x-foo' });
  });
});

describe('rendering what a decoder read', () => {
  it('names the decoder, so decoded bytes are never taken for JSON', () => {
    const view = toPayloadView(new Uint8Array([0x7f, 42]), {
      classification: { kind: 'decoded', decodedBy: 'marker' },
      decoders: [marker],
      topic: 'plc/state',
    });

    expect(view.kind).toBe('decoded');
    if (view.kind === 'decoded') {
      expect(view.decoder).toBe('marker');
    }
  });

  it('redacts a decoded payload exactly as it would a JSON one', () => {
    // A Sparkplug payload can carry a credential as easily as a JSON one.
    const view = toPayloadView(new Uint8Array([0x7f, 42]), {
      classification: { kind: 'decoded', decodedBy: 'marker' },
      decoders: [marker],
      redactKeys: ['token'],
    });

    expect(JSON.stringify(view)).not.toContain('hunter2');
    expect(JSON.stringify(view)).toContain('[REDACTED]');
  });

  it('falls back to binary when the decoder that read it is gone', () => {
    // Removed from the configuration, or the stored bytes are a prefix it cannot parse.
    // Saying "binary" beats inventing a value.
    const view = toPayloadView(new Uint8Array([0x7f, 42]), {
      classification: { kind: 'decoded', decodedBy: 'marker' },
      decoders: [],
    });

    expect(view.kind).toBe('binary');
  });
});
