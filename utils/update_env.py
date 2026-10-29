import os
import re
import argparse
import sys

"""
This script updates environment variables in a .env file with values from the local environment.
Specifically, it looks for variables set to "GET_FROM_LOCAL_ENV" in the input .env file and replaces them
with the corresponding values from the local environment variables.

Usage:
1. Prepare an input .env file with some variables set to "GET_FROM_LOCAL_ENV".
   Example input .env file (input.env):
   # Example configuration

   API_KEY=GET_FROM_LOCAL_ENV
   DB_PASSWORD=GET_FROM_LOCAL_ENV
   HOST=localhost
   PORT=3080

2. Set the corresponding environment variables in your local environment.
   Example in bash:
   export API_KEY=new_api_key_value
   export DB_PASSWORD=new_db_password_value

3. Run the script, specifying the input and output file paths.
   Example:
   python update_env.py input.env output.env
"""

def read_env_file(file_path):
    """Reads the .env file and returns the lines as a list."""
    with open(file_path, 'r') as file:
        lines = file.readlines()
    return lines

def write_env_file(file_path, lines):
    """Writes the updated lines to the specified .env file."""
    with open(file_path, 'w') as file:
        file.writelines(lines)

def update_env_file_with_local_env(input_file_path, output_file_path):
    """
    Reads the input .env file, updates the variables set to GET_FROM_LOCAL_ENV
    with values from the local environment, and writes the result to the output .env file.
    """
    lines = read_env_file(input_file_path)
    updated_lines = []
    # Regex pattern to match lines ending with "GET_FROM_LOCAL_ENV"
    env_var_pattern = re.compile(r'^\s*([A-Z_]+)=GET_FROM_LOCAL_ENV\s*$')
    missing_vars = []
    updated_vars = []

    for line in lines:
        match = env_var_pattern.match(line)
        if match:
            key = match.group(1)
            # Check if the environment variable is set in the local environment
            if key in os.environ:
                new_value = os.environ[key]
                updated_line = f'{key}={new_value}\n'
                updated_lines.append(updated_line)
                updated_vars.append(key)
            else:
                missing_vars.append(key)
        else:
            updated_lines.append(line)

    # Print warnings and exit if any required environment variables are missing
    if missing_vars:
        for var in missing_vars:
            print(f"Warning: {var} set to GET_FROM_LOCAL_ENV, could not find {var}, please set {var} in your local environment and run again.")
        sys.exit(1)

    # Write the updated lines to the output .env file
    write_env_file(output_file_path, updated_lines)

    # Print the list of updated variables
    if updated_vars:
        print("Updated the following variables:")
        for var in updated_vars:
            print(var)

    print(f"Processed {input_file_path} and wrote updates to {output_file_path}.")

if __name__ == "__main__":
    # Parse command-line arguments for input and output file paths
    parser = argparse.ArgumentParser(description='Update .env file with local environment variables.')
    parser.add_argument('input_file_path', type=str, help='Path to the input .env file')
    parser.add_argument('output_file_path', type=str, help='Path to the output .env file')
    args = parser.parse_args()

    # Update the .env file with local environment variables
    update_env_file_with_local_env(args.input_file_path, args.output_file_path)
