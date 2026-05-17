CropCart Local Frontend

This folder is configured to use the local Django API at:
  http://127.0.0.1:8000/api

How to run quickly:
1. Make sure the local API is running:
   python manage.py runserver 127.0.0.1:8000

2. Open this frontend folder in VS Code.

3. Right-click index.html and choose Open with Live Server.

4. Test uploads from:
   - farmer-register.html for farm logo uploads
   - farmer.html for product image create/edit uploads

5. Check uploaded images in the API project's media folder.

Important:
- Do not manually set Content-Type for FormData upload requests.
- If the browser blocks requests, confirm the frontend is running from http://127.0.0.1:5500 or http://localhost:5500 and the API CORS settings allow it.
