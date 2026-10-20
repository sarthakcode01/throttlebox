'use client';

import { useState } from 'react';
import type { ApiKeyCreatedResponse } from '@throttlebox/shared';
import Modal from './Modal';

interface KeyRevealProps {
  result: ApiKeyCreatedResponse;
  onDismiss: () => void;
}

/**
 * Shows a raw API key exactly once.
 *
 * The key is never persisted — it is not written to localStorage or
 * sessionStorage, and it disappears from component state as soon as this
 * dialog is dismissed. There is no way to get it back, which is the point.
 */
export default function KeyReveal({ result, onDismiss }: KeyRevealProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(result.key);
      setCopied(true);
    } catch {
      // Clipboard access can be denied; the key is still selectable by hand.
      setCopied(false);
    }
  }

  return (
    <Modal title="Copy your API key now" onClose={onDismiss}>
      <div className="stack">
        <div className="warning" role="alert">
          {result.warning} Store it somewhere safe — if you lose it, rotate the key to get a new
          one.
        </div>

        <div className="stack" style={{ gap: 8 }}>
          <code className="key-reveal">{result.key}</code>
          <div className="row">
            <button onClick={copy}>{copied ? 'Copied' : 'Copy key'}</button>
            <span className="muted">
              Environment: <strong>{result.env}</strong> · Scopes:{' '}
              <strong>{result.scopes.join(', ')}</strong>
            </span>
          </div>
        </div>

        <button className="secondary" onClick={onDismiss}>
          I&apos;ve saved it — close
        </button>
      </div>
    </Modal>
  );
}
