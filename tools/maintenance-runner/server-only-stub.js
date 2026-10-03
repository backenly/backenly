// `server-only` is a build-time marker with no runtime behaviour. It is not in
// the runtime image's node_modules, so it is aliased to this empty module
// rather than left external, which would fail at require.
module.exports = {}
