#!/usr/bin/env python3
import http.server
import ssl
import os

os.chdir(os.path.dirname(os.path.abspath(__file__)))

server_address = ('0.0.0.0', 8443)
httpd = http.server.HTTPServer(server_address, http.server.SimpleHTTPRequestHandler)

context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain('cert.pem', 'key.pem')
httpd.socket = context.wrap_socket(httpd.socket, server_side=True)

print(f"HTTPS Server running on https://localhost:8443")
print(f"Mobile: https://192.168.68.57:8443")
httpd.serve_forever()
