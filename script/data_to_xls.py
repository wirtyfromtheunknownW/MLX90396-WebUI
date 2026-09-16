import os
import pandas as pd

# Get the directory where script/data_to_xls.py is located
script_dir = os.path.dirname(os.path.abspath(__file__))
file_path = os.path.join(script_dir, "data.txt")

headers = [
    "X0", "X1", "X2", "X3",
    "Y0", "Y1", "Y2", "Y3",
    "Z0", "Z1", "Z2", "Z3",
    "X", "Y", "Angle"
]

# Read the file using the absolute path
df = pd.read_csv(file_path, sep="|", header=None, names=headers)

# Save the output file in the same folder
output_path = os.path.join(script_dir, "formatted_data.xlsx")
df.to_excel(output_path, index=False)

print("Excel file created successfully!")