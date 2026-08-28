/**
 * Typed surface for the virtual `@env` module provided by the
 * react-native-dotenv babel plugin. Add one declaration per variable used
 * in application source and document it in mobile/.env.example.
 */
declare module '@env' {
  export const API_BASE_URL: string | undefined;
}
