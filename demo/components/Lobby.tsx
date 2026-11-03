'use client';

import { ArrowRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { meetingPathFromInput } from '@/lib/room';
import { Wordmark } from './ui/Device';

export function Lobby() {
  const router = useRouter();
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);

  return (
    <main className="lobby">
      <header className="page-top">
        <Wordmark />
      </header>

      <section className="lobby-start" aria-labelledby="lobby-title">
        <h1 id="lobby-title" className="display">
          Join a&nbsp;meeting
        </h1>

        <form
          className="face lobby-form"
          onSubmit={(event) => {
            event.preventDefault();
            const path = meetingPathFromInput(value);
            if (path) router.push(path);
            else setInvalid(true);
          }}
        >
          <label className="field-label" htmlFor="meeting-link">
            Paste a meeting link or code
          </label>
          <input
            id="meeting-link"
            className="field mono"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setInvalid(false);
            }}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            aria-invalid={invalid}
            aria-describedby="meeting-hint"
          />
          <button type="submit" className="key key-go key-wide">
            Join
            <ArrowRight aria-hidden="true" />
          </button>
        </form>
        <p id="meeting-hint" className="note">
          Meetings are created from HOF ERP.
        </p>
        <p className="note note-alert" role="alert" hidden={!invalid}>
          That is not a meeting link or code.
        </p>
      </section>
    </main>
  );
}
