/**
 * Root navigation switch (TASK-043): while the session is being restored a
 * splash screen is shown; unauthenticated users get the auth stack and
 * authenticated users the main application stack. Swapping whole navigators
 * keeps each flow's state isolated, so logout always lands on Login and
 * login always lands on Chat.
 *
 * Mode-aware routing (TASK-AUDIT-003): serverless mode is independent of
 * server authentication, so a restored serverless selection mounts the main
 * application stack directly — the login flow is never shown on cold start
 * — while server mode keeps the authentication-gated behavior.
 */
import React from 'react';

import {useAuth} from '../auth/AuthContext';
import {useApplicationMode} from '../mode/ModeContext';
import {SplashScreen} from '../screens/SplashScreen';
import {AuthNavigator} from './AuthNavigator';
import {MainNavigator} from './MainNavigator';

export function RootNavigator() {
  const {status: modeStatus, mode} = useApplicationMode();
  const {status: authStatus} = useAuth();

  if (modeStatus === 'loading' || authStatus === 'loading') {
    return <SplashScreen />;
  }

  if (mode === 'serverless') {
    return <MainNavigator />;
  }

  return authStatus === 'authenticated' ? <MainNavigator /> : <AuthNavigator />;
}
