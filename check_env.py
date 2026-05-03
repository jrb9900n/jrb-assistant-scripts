import os
api_key = os.environ.get('BRAVE_SEARCH_API_KEY', 'NOT SET')
print(f"BRAVE_SEARCH_API_KEY={api_key}")
