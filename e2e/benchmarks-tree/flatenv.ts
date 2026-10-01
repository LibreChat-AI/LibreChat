/** Side-effect module: pins the flat thread renderer ON for the parity config, whatever the default. */
process.env.VITE_FLAT_THREAD = process.env.VITE_FLAT_THREAD ?? 'true';
