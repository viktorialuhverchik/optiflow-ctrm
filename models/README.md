# Model weights

The `.gguf` files are not committed. `manifest.json` is, and it pins each model by
SHA-256 so a re-download can be checked without trusting this machine.

Two models are listed. **Only the first is needed** to run the extractor, the
eval, the MCP server and the demo.

## Qwen3-8B, required, 4.7 GB

The shipped model. Every headline number in the README comes from it.

```bash
curl -L -o models/Qwen3-8B-Q4_K_M.gguf \
  https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf
pnpm model:verify --model qwen3-8b-q4km
```

## Qwen3-4B, optional, 2.3 GB

Used only to reproduce the model-size row of the configuration comparison. Nothing
depends on it, and it is not the shipped model.

```bash
curl -L -o models/Qwen3-4B-Q4_K_M.gguf \
  https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf
```

## Verifying

`pnpm model:verify` with no arguments checks every model in the manifest, so it
reports the 4B as `MISSING` and exits non-zero if you skipped it. Pass `--model`
to check only what you downloaded.

The hash in the manifest is the upstream Hugging Face LFS object id, so it can be
checked against the source rather than only against a local copy:

```bash
curl -s -X POST https://huggingface.co/api/models/Qwen/Qwen3-8B-GGUF/paths-info/main \
  -H 'content-type: application/json' -d '{"paths":["Qwen3-8B-Q4_K_M.gguf"]}'
```
