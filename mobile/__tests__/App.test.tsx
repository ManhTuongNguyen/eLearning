import React from 'react';
import { render } from '@testing-library/react-native';
import App from '../App';

describe('App', () => {
  it('renders the welcome content', async () => {
    const { getByText } = await render(<App />);

    expect(getByText(/Welcome to React Native/i)).toBeOnTheScreen();
  });
});
