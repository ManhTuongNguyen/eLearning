module.exports = {
  root: true,
  extends: '@react-native',
  env: {
    jest: true,
  },
  overrides: [
    {
      // The icon library is an implementation detail of the single seam
      // (TASK-SENT-001): every screen asks for a semantic name instead.
      files: ['src/**/*.ts', 'src/**/*.tsx'],
      excludedFiles: ['src/components/Icon.tsx'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              {
                name: 'lucide-react-native',
                message: 'Import icons through src/components/Icon.tsx (the icon seam).',
              },
            ],
          },
        ],
      },
    },
  ],
};