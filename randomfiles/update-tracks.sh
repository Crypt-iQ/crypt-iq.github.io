#!/bin/bash
# update-tracks.sh
# Scans ./audio and rewrites the TRACKS list in ./index.html.
# Run from the same directory as index.html.
#
# Usage:
#   chmod +x update-tracks.sh   (one time)
#   ./update-tracks.sh

set -eu

AUDIO_DIR="audio"
HTML_FILE="index.html"

[ -d "$AUDIO_DIR" ] || { echo "Error: '$AUDIO_DIR' folder not found (cd to where index.html lives)" >&2; exit 1; }
[ -f "$HTML_FILE" ] || { echo "Error: '$HTML_FILE' not found in $(pwd)" >&2; exit 1; }

# Collect audio filenames (case-insensitive), sorted alphabetically.
# Tip: prefix filenames with "01-", "02-", ... if you want a specific order.
names=()
while IFS= read -r name; do
    [ -n "$name" ] && names+=("$name")
done < <(
    find "$AUDIO_DIR" -maxdepth 1 -type f \( \
        -iname "*.mp3" -o -iname "*.m4a" -o -iname "*.ogg" -o \
        -iname "*.wav" -o -iname "*.flac" -o -iname "*.aac" \
    \) -exec basename {} \; | LC_ALL=C sort
)

if [ ${#names[@]} -eq 0 ]; then
    echo "No audio files found in $AUDIO_DIR/" >&2
    exit 1
fi

# Write the new TRACKS block to a temp file (avoids BSD awk's multi-line -v quirks).
block_file=$(mktemp)
tmp=$(mktemp)
trap 'rm -f "$block_file" "$tmp"' EXIT

{
    echo "const TRACKS = ["
    for name in "${names[@]}"; do
        # Escape any single quotes in the filename (rare but possible).
        escaped=$(printf '%s' "$name" | sed "s/'/\\\\'/g")
        echo "  '$AUDIO_DIR/$escaped',"
    done
    echo "];"
} > "$block_file"

# Splice the new block into index.html by reading it from the temp file inside awk.
if ! awk -v block_file="$block_file" '
    BEGIN {
        block = ""
        while ((getline line < block_file) > 0) {
            block = block (block == "" ? "" : "\n") line
        }
        close(block_file)
        found = 0
    }
    /^[[:space:]]*const TRACKS = \[/ {
        found = 1
        print block
        if ($0 ~ /\];/) next
        while ((getline) > 0) if ($0 ~ /\];/) break
        next
    }
    { print }
    END { if (!found) exit 2 }
' "$HTML_FILE" > "$tmp"; then
    echo "Error: Could not find 'const TRACKS = [' in $HTML_FILE" >&2
    exit 1
fi

# Overwrite index.html with the result (cat keeps the original inode).
cat "$tmp" > "$HTML_FILE"

echo "Updated $HTML_FILE with ${#names[@]} tracks:"
printf '  %s\n' "${names[@]}"
