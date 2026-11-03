'use client';

import { ArrowRight, Clock, Laptop, Mic, ShieldCheck, UserCheck, Wifi } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { meetingPathFromInput } from '@/lib/room';
import { Wordmark } from './ui/Device';

const STEPS = [
  {
    icon: Clock,
    title: 'Open your link',
    body: 'Links open 15 minutes before the start time. Arrive earlier and the page tells you when it starts.',
  },
  {
    icon: Mic,
    title: 'Check camera and mic',
    body: 'You see your own preview and pick devices before anyone sees or hears you.',
  },
  {
    icon: UserCheck,
    title: 'Get let in',
    body: 'If the host keeps a waiting room, you join as soon as they admit you.',
  },
];

/** Stagger slot for the reveal animation (`--i` × 80 ms). */
const order = (i: number) => ({ '--i': i }) as CSSProperties;

export function Lobby() {
  const router = useRouter();
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);
  const mainRef = useRef<HTMLElement>(null);

  // Blocks below the fold fade in as they scroll into view. Only blocks still off screen once the
  // page is interactive get hidden, so nothing on screen at load ever blinks out and back in.
  useEffect(() => {
    const main = mainRef.current;
    if (!main || !('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          delete (entry.target as HTMLElement).dataset.pending;
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: '0px 0px -8% 0px' },
    );
    main.querySelectorAll<HTMLElement>('[data-reveal]').forEach((el) => {
      if (el.getBoundingClientRect().top < window.innerHeight) return;
      el.dataset.pending = '';
      observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  return (
    <main className="lobby" ref={mainRef}>
      <header className="page-top lobby-top">
        <Wordmark />
        <a className="key key-quiet" href="/admin">
          Control Center
        </a>
      </header>

      <section className="lobby-hero" aria-labelledby="lobby-title">
        <div className="lobby-pattern" aria-hidden="true" />
        <div className="lobby-copy lobby-rise" style={order(0)}>
          <h1 id="lobby-title" className="lobby-display">
            Join a&nbsp;meeting
          </h1>
          <p className="lede">Open the link from your invite, or paste it here.</p>
        </div>

        <div className="lobby-join lobby-rise" style={order(1)}>
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
              Meeting link or code
            </label>
            <input
              id="meeting-link"
              className="field mono"
              placeholder="spaces.hof-global.com/rooms/…"
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setInvalid(false);
              }}
              autoComplete="off"
              spellCheck={false}
              autoFocus
              aria-invalid={invalid}
              aria-describedby="meeting-hint meeting-error"
            />
            <button type="submit" className="key key-go key-wide">
              Join
              <ArrowRight aria-hidden="true" />
            </button>
            <p id="meeting-error" className="note note-alert lobby-error" role="alert" hidden={!invalid}>
              That is not a meeting link or code.
            </p>
          </form>
          <p id="meeting-hint" className="note lobby-hint">
            Meetings are created from HOF ERP.
          </p>
        </div>
      </section>

      <section className="lobby-section" aria-labelledby="steps-title">
        <h2 id="steps-title" className="title" data-reveal>
          What happens when you join
        </h2>
        <ol className="lobby-steps">
          {STEPS.map(({ icon: Icon, title, body }, index) => (
            <li key={title} className="lobby-step" data-reveal style={order(index)}>
              <span className="lobby-step-head">
                <span className="lobby-step-num mono">{String(index + 1).padStart(2, '0')}</span>
                <Icon aria-hidden="true" />
              </span>
              <h3>{title}</h3>
              <p>{body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="lobby-section" aria-labelledby="know-title">
        <h2 id="know-title" className="title" data-reveal>
          Good to know
        </h2>
        <div className="lobby-bento">
          <article className="lobby-cell lobby-cell-rec" data-reveal style={order(0)}>
            <span className="readout lobby-rec" aria-hidden="true">
              <span className="readout-seg readout-rec">
                <span className="led led-alert led-pulse" />
                REC
              </span>
              <span className="readout-seg">Audio only</span>
            </span>
            <h3>Recording is always visible</h3>
            <p>When a call is recorded, the REC badge stays on screen for everyone. Only the audio is kept, and it is transcribed.</p>
          </article>

          <article className="lobby-cell lobby-cell-net" data-reveal style={order(1)}>
            <span className="lobby-cell-icon">
              <ShieldCheck aria-hidden="true" />
            </span>
            <h3>Works on strict networks</h3>
            <p>If an office network blocks calls, media goes through a relay over HTTPS instead.</p>
          </article>

          <article className="lobby-cell lobby-cell-device" data-reveal style={order(2)}>
            <span className="lobby-cell-icon">
              <Laptop aria-hidden="true" />
              <Wifi aria-hidden="true" />
            </span>
            <h3>Desktop or phone</h3>
            <p>Use an up to date Chrome, Edge or Safari. On a phone, keep the screen on and prefer Wi-Fi.</p>
          </article>
        </div>
      </section>
    </main>
  );
}
