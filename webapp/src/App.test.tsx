/**
 * App smoke test.
 *
 * This file used to be the untouched Create-React-App scaffold — it looked for
 * a "learn react" link that this application has never rendered, so it could
 * only ever fail. (Until `@tanstack/react-query` was restored to node_modules
 * it could not even be run, which is why the red went unnoticed.)
 *
 * What is actually worth asserting here is that the app mounts: the router,
 * the query client, the auth context and the theme provider all come up and
 * land an unauthenticated visitor on the sign-in screen.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import App from './App';

test('mounts and renders the sign-in screen for an unauthenticated visitor', async () => {
  render(<App />);

  expect(await screen.findByText(/sign in to your account/i)).toBeInTheDocument();
  expect(screen.getByPlaceholderText(/enter your username/i)).toBeInTheDocument();
  expect(screen.getByPlaceholderText(/enter your password/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
});
