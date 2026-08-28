/** Learning profile endpoint bindings (SPEC TASK-017 API). */

import type {AuthedRequester} from '../auth/authedRequest';

export type EnglishLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2' | 'AUTO';

export interface LevelOption {
  value: EnglishLevel;
  label: string;
  description: string;
}

export const LEVELS: readonly LevelOption[] = [
  {value: 'A1', label: 'A1 — Beginner', description: 'Simple, everyday phrases'},
  {value: 'A2', label: 'A2 — Elementary', description: 'Frequent routine expressions'},
  {value: 'B1', label: 'B1 — Intermediate', description: 'Connected text on familiar topics'},
  {value: 'B2', label: 'B2 — Upper Intermediate', description: 'Clear detailed arguments'},
  {value: 'C1', label: 'C1 — Advanced', description: 'Flexible, effective use of English'},
  {value: 'C2', label: 'C2 — Proficiency', description: 'Near-native ease and precision'},
  {value: 'AUTO', label: 'Auto', description: 'Let the AI decide your level'},
];

export interface LearningProfile {
  level: EnglishLevel;
}

/** Runs through the central authed requester (TASK-AUDIT-005). */
export function getProfile(request: AuthedRequester): Promise<LearningProfile> {
  return request<LearningProfile>('/api/v1/profile/');
}

/** Runs through the central authed requester (TASK-AUDIT-005). */
export function updateProfile(
  request: AuthedRequester,
  level: EnglishLevel,
): Promise<LearningProfile> {
  return request<LearningProfile>('/api/v1/profile/', {
    method: 'PATCH',
    body: {level},
  });
}
