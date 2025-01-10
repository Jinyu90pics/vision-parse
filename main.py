from flask import Flask, request, jsonify
from src.vision_parse import VisionParser
import os
import logging

try:
    from dotenv import load_dotenv
except ImportError:
    print('没有找到dotenv模块,需要安装: pip install dotenv')
    exit()
    
load_dotenv()


app = Flask(__name__)

# Initialize parser (from gemini_demo.ipynb, adapt as needed)
parser = VisionParser(
    model_name="gemini-1.5-flash",  # Replace with your actual model name if different
    api_key=os.environ.get("GEMINI_API_KEY"), # Get API key from environment variable
    temperature=0.2,
    top_p=0.4,
    max_output_tokens=8192,
    image_mode="url",
    detailed_extraction=True,
)


logging.basicConfig(level=logging.DEBUG)

@app.route('/', methods=['POST'])
def process_file():
    try:
        if 'file' not in request.files:
            logging.error("No file part")
            return jsonify({'error': 'No file part'}), 400
        file = request.files['file']
        if file.filename == '':
            logging.error("No selected file")
            return jsonify({'error': 'No selected file'}), 400

        # Save the uploaded file temporarily
        temp_path = 'temp.' + file.filename.split('.')[-1]
        file.save(temp_path)
        logging.info(f"File saved to {temp_path}")
        logging.info(f"File size: {os.path.getsize(temp_path)} bytes")
        logging.info(f"Content type: {request.content_type}")
        logging.info(f"Content length: {request.content_length}")
        logging.debug(f"Request data: {request.data}")

        if temp_path.lower().endswith(('.pdf')):
            markdown_pages = parser.convert_file(temp_path)
        elif temp_path.lower().endswith(('.jpg', '.jpeg', '.png')):
            markdown_pages = parser.convert_image(temp_path)
        else:
            logging.error(f"Unsupported file type: {temp_path}")
            return jsonify({'error': 'Unsupported file type'}), 400

        os.remove(temp_path)
        logging.info(f"File removed: {temp_path}")

        # Format output as JSON
        output = []
        for i, page_content in enumerate(markdown_pages):
            output.append({"page": i+1, "content": page_content})

        return jsonify(output)

    except Exception as e:
        logging.exception(f"An error occurred: {e}")
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
