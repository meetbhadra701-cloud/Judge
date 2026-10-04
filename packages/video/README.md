# packages/video — video/demo metadata adapter

**Milestone:** M2 · **Layer:** 3 (I/O adapter)

Metadata only. YouTube, Vimeo and Loom are detected from the URL and queried through their fixed
oEmbed endpoints; other URLs are read as web pages for public metadata (`partial`,
`generic_metadata_only`). Media streams are never downloaded, frames never analysed, speech never
transcribed. A duration is recorded only when the provider states it.
