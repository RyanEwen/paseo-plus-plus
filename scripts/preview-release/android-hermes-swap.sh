#!/usr/bin/env bash
# Swap-table helpers for the Hermes driver, sourced by android-hermes.sh and its tests.

# Print the used bytes of swap file $1 from the rows of
# `swapon --show=NAME,USED --bytes --noheadings` on stdin.
# Exits non-zero when the file is not listed, so callers can tell inactive swap from zero use.
swap_used_bytes() {
  awk -v file="$1" '$1 == file {print $2; found=1} END {exit !found}'
}
