import { useAuth } from '../auth/AuthContext';
import { useApplicationMode } from '../mode/ModeContext';
import { SplashScreen } from '../screens/SplashScreen';
import { AuthNavigator } from './AuthNavigator';
import { MainNavigator } from './MainNavigator';

export function RootNavigator() {
  const { status: modeStatus, mode } = useApplicationMode();
  const { status: authStatus } = useAuth();

  if (modeStatus === 'loading' || authStatus === 'loading') {
    return <SplashScreen />;
  }

  if (mode === 'serverless') {
    return <MainNavigator />;
  }

  return authStatus === 'authenticated' ? <MainNavigator /> : <AuthNavigator />;
}
