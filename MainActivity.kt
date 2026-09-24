- name: Repair MainActivity worker callback
        shell: bash
        run: |
          set -e

          FILE="$HABITAT_PROJECT_DIR/app/src/main/java/com/habitat/core/MainActivity.kt"

          test -f "$FILE"

          python3 - "$FILE" <<'PY'
          import sys
          from pathlib import Path

          path = Path(sys.argv[1])
          source = path.read_text()

          marker = "workerAdapter"
          pos = source.find(marker)

          if pos < 0:
              print("ERROR: MainActivity does not contain 'workerAdapter'.")
              print(source)
              sys.exit(1)

          # Do not depend on the exact formatting of workerAdapter.run(...).
          # Locate the callback lambda directly after workerAdapter.
          brace = source.find("{", pos)
          arrow = source.find("->", brace + 1) if brace >= 0 else -1

          if brace < 0 or arrow < 0:
              print("ERROR: Could not locate the worker callback lambda.")
              print()
              print("Relevant source around workerAdapter:")
              print(source[max(0, pos-300):min(len(source), pos+1200)])
              sys.exit(1)

          old_params = source[brace + 1:arrow].strip()

          # WorkerAdapter expects:
          # (Boolean, String, String) -> Unit
          #
          # MainActivity uses:
          # ok
          # text
          # detail
          #
          # Force the callback to receive all three values.
          source = (
              source[:brace + 1]
              + "\n            ok, text, detail "
              + source[arrow:]
          )

          path.write_text(source)

          print("SUCCESS: MainActivity worker callback repaired.")
          print(f"Previous callback parameters: {old_params!r}")

          # Verify the repair.
          check = path.read_text()

          worker_pos = check.find("workerAdapter")
          repaired_pos = check.find("ok, text, detail", worker_pos)

          if worker_pos < 0 or repaired_pos < 0:
              print("ERROR: MainActivity callback repair could not be verified.")
              sys.exit(1)

          print("MainActivity callback repair VERIFIED.")
          PY

      - name: Verify MainActivity repair
        shell: bash
        run: |
          set -e

          FILE="$HABITAT_PROJECT_DIR/app/src/main/java/com/habitat/core/MainActivity.kt"

          echo "=============================================="
          echo "MAIN ACTIVITY AFTER REPAIR"
          echo "=============================================="

          grep -n -C 5 "workerAdapter" "$FILE"

          python3 - "$FILE" <<'PY'
          import sys
          from pathlib import Path

          source = Path(sys.argv[1]).read_text()

          worker_pos = source.find("workerAdapter")
          repaired_pos = source.find("ok, text, detail", worker_pos)

          if worker_pos < 0 or repaired_pos < 0:
              print("ERROR: MainActivity callback repair was not verified.")
              sys.exit(1)

          print("MainActivity callback repair VERIFIED.")
          PY
