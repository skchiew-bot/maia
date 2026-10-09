import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { vi } from 'vitest';
import { ClockProvider, ToastProvider, fixedClock } from '../../src/components';
import ProjectPage from '../../src/pages/projects/ProjectPage';
import ProjectsPage from '../../src/pages/projects/ProjectsPage';
import { jsonResponse, mockFetch } from '../helpers';
import {
  CX_DETAIL,
  CX_HISTORY,
  CX_TIMELINE,
  DECISIONS,
  NOW,
  PLAYBOOKS,
  REGISTRY,
  ROLLUPS,
  SESSIONS,
  SPEND,
  SUMMARIES,
  THREAD,
} from './fixtures';

export interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

/** GET routes answered from the fixtures; `overrides` replace any of them (a function may fail on purpose). */
export function serve(overrides: Record<string, unknown | ((url: URL) => Response)> = {}) {
  const writes: Recorded[] = [];
  const routes: Record<string, unknown | ((url: URL) => Response)> = {
    '/api/projects': SUMMARIES,
    '/api/projects/rollup': ROLLUPS,
    '/api/sessions': (url: URL) => {
      const projectId = url.searchParams.get('projectId');
      return jsonResponse(projectId ? SESSIONS.filter((s) => s.projectId === projectId) : SESSIONS);
    },
    '/api/metering/summary': SPEND,
    '/api/projects/prj_cx': CX_DETAIL,
    '/api/projects/prj_cx/timeline': CX_TIMELINE,
    '/api/projects/prj_cx/history': CX_HISTORY,
    '/api/decisions': DECISIONS,
    '/api/changes': { items: [] },
    '/api/rollbacks': { items: [] },
    '/api/registry/process-types': REGISTRY,
    '/api/playbooks': PLAYBOOKS,
    '/api/threads/thr_cx_main': THREAD,
    ...overrides,
  };
  const fetchMock = mockFetch(async (raw, init) => {
    const url = new URL(raw, 'http://localhost');
    const method = (init.method ?? 'GET').toUpperCase();
    if (method !== 'GET') {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      writes.push({ method, path: url.pathname, body });
      const handler = routes[`${method} ${url.pathname}`];
      if (typeof handler === 'function') return (handler as (u: URL) => Response)(url);
      return jsonResponse(handler ?? {}, { status: method === 'POST' ? 201 : 200 });
    }
    const handler = routes[url.pathname];
    if (handler === undefined) return jsonResponse({ error: { code: 'not_found', message: 'Not found' } }, { status: 404 });
    if (typeof handler === 'function') return (handler as (u: URL) => Response)(url);
    return jsonResponse(handler);
  });
  return { fetchMock, writes };
}

function Location() {
  const l = useLocation();
  return <output data-testid="location">{l.pathname + l.search + l.hash}</output>;
}

export function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ClockProvider clock={fixedClock(NOW)}>
        <ToastProvider>
          <Routes>
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/projects/:id" element={<ProjectPage />} />
          </Routes>
          <Location />
        </ToastProvider>
      </ClockProvider>
    </MemoryRouter>,
  );
}

export function cleanupServer() {
  vi.unstubAllGlobals();
}
