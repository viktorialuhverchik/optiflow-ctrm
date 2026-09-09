# Model weights

The `.gguf` files are not committed. `manifest.json` is, and it pins each model
by SHA-256 so a re-download can be checked without trusting this machine.

To fetch the primary model:

```bash
curl -L -o models/Qwen3-8B-Q4_K_M.gguf \
  https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf
pnpm model:verify
```

`pnpm model:verify` hashes what is on disk and compares it to the manifest. The
hash in the manifest is the upstream Hugging Face LFS object id, which can be
checked independently:

```bash
curl -s -X POST https://huggingface.co/api/models/Qwen/Qwen3-8B-GGUF/paths-info/main \
  -H 'content-type: application/json' -d '{"paths":["Qwen3-8B-Q4_K_M.gguf"]}'
```
