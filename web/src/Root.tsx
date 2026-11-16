// The top-level page: the landing at / (and for anyone not signed in), the app everywhere else.
// Once opened, the app stays mounted under the landing so going back in keeps its state.

import { useCallback, useEffect, useState } from 'react';
import { api, type AuthState } from './api';
import { App } from './App';
import { DEMO } from './demo';
import { Kumo } from './kumo';
import { Landing } from './landing/Landing';
import { go, legacy, parse, usePath } from './route';

const OPEN: AuthState = { local: true, password: false, authed: true, signed_in: false };

export function Root() {
  const p = usePath();
  const route = parse(p);
  const [auth, setAuth] = useState<AuthState | null>(DEMO ? OPEN : null);
  const [err, setErr] = useState('');
  const [inside, setInside] = useState(false);

  const load = useCallback(() => api.authState().then(a => { setAuth(a); setErr(''); return a; }, e => { setErr((e as Error).message); return null; }), []);
  useEffect(() => { if (!DEMO) load(); }, [load]);
  useEffect(() => {
    const out = () => setAuth(a => a && { ...a, authed: a.local, signed_in: false });
    addEventListener('pt-signed-out', out);
    return () => removeEventListener('pt-signed-out', out);
  }, []);
  useEffect(() => {
    if (!auth?.authed || route.view !== 'landing') return;
    const l = legacy();
    if (l) go(l + location.hash, true);
  }, [auth?.authed]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (auth && !auth.authed && route.view !== 'landing') go(`/?next=${encodeURIComponent(p)}`, true);
  }, [auth, p, route.view]);
  useEffect(() => { if (auth?.authed && route.view !== 'landing') setInside(true); }, [auth?.authed, route.view]);

  const landing = route.view === 'landing' || !auth?.authed;
  return (
    <Kumo>
      {auth?.authed && inside && <App route={route} covered={landing} />}
      {landing && <Landing auth={auth} err={err} reload={load} />}
    </Kumo>
  );
}
