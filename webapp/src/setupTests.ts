// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';
import { TextDecoder, TextEncoder } from 'util';

// jest 27's jsdom environment (what CRA 5 pins) predates TextEncoder/
// TextDecoder being globals. react-router@7 reaches for TextEncoder at module
// scope, so importing anything from react-router-dom in a test throws a
// ReferenceError before a single line of the test runs. Node has had both for
// years — hand them to jsdom.
if (typeof (global as any).TextEncoder === 'undefined') {
  (global as any).TextEncoder = TextEncoder;
}
if (typeof (global as any).TextDecoder === 'undefined') {
  (global as any).TextDecoder = TextDecoder;
}
