/** The registry read-through caches encrypt entries before they reach the
 *  shared store, and the crypto module captures CREDS_KEY/CREDS_IV at import
 *  time. Importing this module first lets static-import suites provide them. */
process.env.CREDS_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.CREDS_IV ??= '0123456789abcdef0123456789abcdef';

export {};
