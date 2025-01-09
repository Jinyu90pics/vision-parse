import requests

res = requests.post('http://localhost:5000/', files={'file': open('./examples/07012025160748.pdf', 'rb')}).json()
print(res)