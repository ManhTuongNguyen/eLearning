/**
 * Root navigation switch (TASK-043): while the session is being restored a
 * splash screen is shown; unauthenticated users get the auth stack and
 * authenticated users the main application stack. Swapping whole navigators
 * keeps each flow's state isolated, so logout always lands on Login and
 * login always lands on Chat.
 */
import React from 'react';

import {useAuth} from '../auth/AuthContext';
import {SplashScreen} from '../screens/SplashScreen';
import {AuthNavigator} from './AuthNavigator';
import {MainNavigator} from './MainNavigator';

export function RootNavigator() {
  const {status} = useAuth();

  if (status === 'loading') {
    return <SplashScreen />;
  }

  return status === 'authenticated' ? <MainNavigator /> : <AuthNavigator />;
}
