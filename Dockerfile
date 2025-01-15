FROM python:3.11-slim

WORKDIR /app
RUN apt update && apt install libgl1-mesa-glx libglib2.0-0 gcc -y
ENV GEMINI_API_KEY="AIxxxx"
COPY . /app/
RUN pip install -r requirements.txt
RUN pip install 'vision-parse[gemini]'
EXPOSE 5000
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "4", "--worker-class", "uvicorn.workers.UvicornWorker", "main:app"]
