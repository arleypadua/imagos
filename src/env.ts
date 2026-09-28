// Must be the first import of the CLI entry: ESM evaluates imports in order, so this
// runs before ink/react-reconciler pick their build. The development reconciler records
// a performance.measure() entry per component render into Node's global, never-cleared
// perf buffer, which leaks until the process OOMs on long-running sessions.
process.env.NODE_ENV ??= 'production';
