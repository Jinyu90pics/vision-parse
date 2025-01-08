FROM python:3.13-slim

WORKDIR /app
RUN apt update && apt install libgl1-mesa-glx libglib2.0-0 -y
RUN pip install flask vision-parse 'vision-parse[gemini]'
COPY . /app/
EXPOSE 5000
CMD ["python3", "main.py"] 
