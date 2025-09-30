import sys
import os
import json
import traceback

# Add the 'js/metrics' directory to the Python path so we can import 'calc_p'
# Correctly construct the path to 'js/metrics' relative to this script's location
metrics_path = os.path.abspath(os.path.join(os.path.dirname(__file__), 'js', 'metrics'))
if metrics_path not in sys.path:
    sys.path.append(metrics_path)

try:
    from calc_p import generate_metrics
except ImportError:
    print("Error: Could not import 'generate_metrics' from 'js/metrics/calc_p.py'.")
    print(f"Attempted to load from: {metrics_path}")
    print("Please ensure the file exists and there are no issues within the script.")
    sys.exit(1)

# Define the absolute paths to the asset files
workspace_root = r'c:\MISC\Deepcare\LandmarkPlayer'
upper_stl_path = os.path.join(workspace_root, 'assets', '1_U.stl')
lower_stl_path = os.path.join(workspace_root, 'assets', '1_L.stl')
upper_json_path = os.path.join(workspace_root, 'assets', '1_U.json')
lower_json_path = os.path.join(workspace_root, 'assets', '1_L.json')
output_path = os.path.join(workspace_root, 'metrics_output.json')

# Verify that all input files exist before running
missing_files = []
for path in [upper_stl_path, lower_stl_path, upper_json_path, lower_json_path]:
    if not os.path.exists(path):
        missing_files.append(path)

if missing_files:
    print("Error: The following input files are missing:")
    for path in missing_files:
        print(f"- {path}")
    sys.exit(1)

print("All input files found. Running the test...")

# Execute the generate_metrics function
try:
    metrics_result = generate_metrics(
        upper_stl_path=upper_stl_path,
        lower_stl_path=lower_stl_path,
        upper_json_path=upper_json_path,
        lower_json_path=lower_json_path,
        out_path=output_path
    )

    # Print the results to the console
    print("\n--- Metrics Generation Complete ---")
    print(json.dumps(metrics_result, indent=2, ensure_ascii=False))
    print(f"\nResults have been saved to: {output_path}")

except Exception as e:
    print(f"\nAn error occurred while running generate_metrics:")
    traceback.print_exc()


