# Changelog

## [0.2.0](https://github.com/ryancormack/strands-acp/compare/v0.1.1...v0.2.0) (2026-10-02)


### ⚠ BREAKING CHANGES

* AcpAgent is no longer exported and no longer takes a connection. Use createAgentApp(config) for custom transports. createStdioServer returns an AgentConnection instead of an AgentSideConnection.

### Bug Fixes

* **deps:** bump @agentclientprotocol/sdk to ^1.7.0 ([#23](https://github.com/ryancormack/strands-acp/issues/23)) ([b23137b](https://github.com/ryancormack/strands-acp/commit/b23137b68b2dcb84ea931cc1ec58281c0530ba62))


### Code Refactoring

* serve the bridge through the agent() builder ([#25](https://github.com/ryancormack/strands-acp/issues/25)) ([715f779](https://github.com/ryancormack/strands-acp/commit/715f779890600d31b7254cfbce605b2809065f2c))

## [0.1.1](https://github.com/ryancormack/strands-acp/compare/v0.1.0...v0.1.1) (2026-10-02)


### Bug Fixes

* **ci:** accept component-prefixed release tags and allow manual publish ([#18](https://github.com/ryancormack/strands-acp/issues/18)) ([0e5bb3a](https://github.com/ryancormack/strands-acp/commit/0e5bb3a435df4ca0345d42ea72553eb71230f1f1))
* **ci:** allow npm version to match the already-bumped package.json ([#20](https://github.com/ryancormack/strands-acp/issues/20)) ([49f1aeb](https://github.com/ryancormack/strands-acp/commit/49f1aeb819c23b8c28e846a58848566cd9bf86ee))

## [0.1.0](https://github.com/ryancormack/strands-acp/compare/strands-acp-v0.0.7...strands-acp-v0.1.0) (2026-10-02)


### Features

* add AcpBridgeConfig, content block mapping, configurable capabilities, and session param passthrough ([83c1b48](https://github.com/ryancormack/strands-acp/commit/83c1b488c00d09cdaddb4233bd4ed3092b4115ed))
* add an optional session store so session/list survives a restart ([6007f9b](https://github.com/ryancormack/strands-acp/commit/6007f9b5d0ba571e17d62172906e78f7500a23b0))
* add loadSession method, fix rawInput forwarding, fix deduplication behavior ([ca5c4a8](https://github.com/ryancormack/strands-acp/commit/ca5c4a87f9917217d80682c101206eaefb50bb54))
* add loadSession, fix rawInput forwarding and deduplication ([967d95a](https://github.com/ryancormack/strands-acp/commit/967d95a78626904eb417f36cca377255f1067333))
* add permission gating, tool kinds, and richer session updates ([f1b722d](https://github.com/ryancormack/strands-acp/commit/f1b722d4da594ae746583924ec74bec9839af0a2))
* add permission gating, tool kinds, and richer session updates ([795eb17](https://github.com/ryancormack/strands-acp/commit/795eb1777e3cfb39d5d34472d51c2ebcec119329))
* create strands-acp package with ACP bridge for Strands agents ([0982cbd](https://github.com/ryancormack/strands-acp/commit/0982cbda1fd16f6d05c4411dbc0701dc04fe76a0))
* optional session store so session/list survives a restart ([42c1440](https://github.com/ryancormack/strands-acp/commit/42c144023d946fa15e531c2ba260878b06ddaf00))


### Bug Fixes

* address review issues in ACP bridge refactoring ([9413e7c](https://github.com/ryancormack/strands-acp/commit/9413e7cc362c04f93d6847fb11157b15f576d81b))
* approve esbuild build scripts for pnpm ([4a863cc](https://github.com/ryancormack/strands-acp/commit/4a863ccfd854d0815334174ed7273fdb3e195634))
* approve esbuild build scripts for pnpm ([d24d8b9](https://github.com/ryancormack/strands-acp/commit/d24d8b9011097f8b379d6121a1c8980b98df19da))
* defer to an intervention handler that already denied a tool call ([7f857df](https://github.com/ryancormack/strands-acp/commit/7f857df4a2380ad0e7d97dc466e2be1697e3c7cb))
* defer to intervention handlers + guarantee usable session ids ([93ba39e](https://github.com/ryancormack/strands-acp/commit/93ba39e6afe7ac1e3e6795524d6cf563d3b4ec1b))
* emit exactly one tool_call per invocation when a call is gated ([c1d6e92](https://github.com/ryancormack/strands-acp/commit/c1d6e92ef14d2ea677a28d97e94b3f2f267dd4e3))
* emit exactly one tool_call per invocation when a call is gated ([0f49dec](https://github.com/ryancormack/strands-acp/commit/0f49dec6af390ece41c903274b625b00dbec3618))
* guarantee generated session ids are usable as Strands session ids ([3ed82bd](https://github.com/ryancormack/strands-acp/commit/3ed82bd591f2de11ebee393c9fe042ec9c6e3eec))
