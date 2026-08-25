/**
 * Application-wide configuration.
 *
 * The Android emulator reaches the host machine's loopback interface at
 * 10.0.2.2, which is where the Docker Compose backend publishes port 8000.
 */
export const API_BASE_URL = 'http://10.0.2.2:8000';
