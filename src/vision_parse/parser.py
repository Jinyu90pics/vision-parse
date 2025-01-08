import fitz  # PyMuPDF library for PDF processing
from pathlib import Path
from typing import Optional, List, Dict, Union, Literal, Any
from tqdm import tqdm
import base64
from pydantic import BaseModel
import asyncio
from .utils import get_device_config
from .llm import LLM
import nest_asyncio
import logging
import warnings

logger = logging.getLogger(__name__)
nest_asyncio.apply()


class PDFPageConfig(BaseModel):
    """Configuration settings for PDF page conversion."""

    dpi: int = 150  # Resolution for PDF to image conversion (72-300 recommended)
    color_space: str = "RGB"  # Color mode for image output
    include_annotations: bool = True  # Include PDF annotations in conversion
    preserve_transparency: bool = False  # Control alpha channel in output


class UnsupportedFileError(BaseException):
    """Custom exception for handling unsupported file errors."""

    pass


class VisionParserError(BaseException):
    """Custom exception for handling Markdown Parser errors."""

    pass


class VisionParser:
    """Convert PDF pages to base64-encoded images and then extract text from the images in markdown format."""

    def __init__(
        self,
        page_config: Optional[PDFPageConfig] = None,
        model_name: str = "gemini-1.5-pro",
        api_key: Optional[str] = None,
        temperature: float = 0.7,
        top_p: float = 0.7,
        gemini_config: Optional[Dict] = None,
        image_mode: Literal["url", "base64", None] = None,
        custom_prompt: Optional[str] = None,
        detailed_extraction: bool = False,
        enable_concurrency: bool = False,
        **kwargs: Any,
    ):
        """Initialize parser with PDFPageConfig and LLM configuration."""
        self.page_config = page_config or PDFPageConfig()
        self.device, self.num_workers = get_device_config()
        self.enable_concurrency = enable_concurrency


        self.llm = LLM(
            model_name=model_name,
            api_key=api_key,
            temperature=temperature,
            top_p=top_p,
            gemini_config=gemini_config,
            image_mode=image_mode,
            detailed_extraction=detailed_extraction,
            custom_prompt=custom_prompt,
            enable_concurrency=enable_concurrency,
            device=self.device,
            num_workers=self.num_workers,
            **kwargs,
        )

    def _calculate_matrix(self, page: fitz.Page) -> fitz.Matrix:
        """Calculate transformation matrix for page conversion."""
        # Calculate zoom factor based on target DPI
        zoom = self.page_config.dpi / 72
        matrix = fitz.Matrix(zoom * 2, zoom * 2)

        # Handle page rotation if present
        if page.rotation != 0:
            matrix.prerotate(page.rotation)

        return matrix

    async def _convert_page(self, page: fitz.Page, page_number: int) -> str:
        """Convert a single PDF page into base64-encoded PNG and extract markdown formatted text."""
        try:
            matrix = self._calculate_matrix(page)

            # Create high-quality image from PDF page
            pix = page.get_pixmap(
                matrix=matrix,
                alpha=self.page_config.preserve_transparency,
                colorspace=self.page_config.color_space,
                annots=self.page_config.include_annotations,
            )

            # Convert image to base64 for LLM processing
            base64_encoded = base64.b64encode(pix.tobytes("png")).decode("utf-8")
            return await self.llm.generate_markdown(base64_encoded, pix, page_number)

        except Exception as e:
            raise VisionParserError(
                f"Failed to convert page {page_number + 1} to base64-encoded PNG: {str(e)}"
            )
        finally:
            # Clean up pixmap to free memory
            if pix is not None:
                pix = None

    async def _convert_pages_batch(self, pages: List[fitz.Page], start_idx: int):
        """Process a batch of PDF pages concurrently."""
        try:
            tasks = []
            for i, page in enumerate(pages):
                tasks.append(self._convert_page(page, start_idx + i))
            return await asyncio.gather(*tasks)
        finally:
            await asyncio.sleep(0.5)

    def convert_file(self, file_path: Union[str, Path]) -> List[str]:
        """Convert the given file (PDF or image) to markdown text.
        
        Args:
            file_path: Path to PDF or image file
            enable_concurrency: If True, processes PDF pages in parallel batches
            num_workers: Number of concurrent workers for PDF processing
            
        Returns:
            List of markdown strings (one per page/image)
            
        Note:
            - Concurrency is only supported for PDF files
            - Image files are processed as single pages
            - Batch size is determined by num_workers
            
        Image Processing Steps:
            1. Validate file exists and is supported image format
            2. Create temporary PDF document with single page
            3. Insert image into page at full resolution
            4. Convert page to base64-encoded PNG
            5. Process image through LLM pipeline
            6. Return markdown text as single-element list
            
        Supported Image Formats:
            - PNG (.png)
            - JPEG (.jpg, .jpeg)
        """
        file_path = Path(file_path)
        converted_pages = []

        if not file_path.exists() or not file_path.is_file():
            raise FileNotFoundError(f"File not found: {file_path}")

        if file_path.suffix.lower() not in [".pdf", ".png", ".jpg", ".jpeg"]:
            raise UnsupportedFileError(f"Unsupported file type: {file_path}")

        try:
            # Handle image files
            if file_path.suffix.lower() in [".png", ".jpg", ".jpeg"]:
                # Create a single-page document from the image
                doc = fitz.open()
                page = doc.new_page()
                rect = page.rect
                page.insert_image(rect, filename=str(file_path))
                
                # Process the single page
                text = asyncio.run(self._convert_page(page, 0))
                return [text]
            
            # Handle PDF files
            with fitz.open(file_path) as pdf_document:
                total_pages = pdf_document.page_count

                with tqdm(
                    total=total_pages,
                    desc="Converting pages into markdown format",
                ) as pbar:
                    if self.enable_concurrency:
                        # Process pages in batches based on num_workers
                        for i in range(0, total_pages, self.num_workers):
                            batch_size = min(self.num_workers, total_pages - i)
                            # Extract only required pages for the batch
                            batch_pages = [
                                pdf_document[j] for j in range(i, i + batch_size)
                            ]
                            batch_results = asyncio.run(
                                self._convert_pages_batch(batch_pages, i)
                            )
                            converted_pages.extend(batch_results)
                            pbar.update(len(batch_results))
                    else:
                        for page_number in range(total_pages):
                            # For non-concurrent processing, still need to run async code
                            text = asyncio.run(
                                self._convert_page(
                                    pdf_document[page_number], page_number
                                )
                            )
                            converted_pages.append(text)
                            pbar.update(1)

                return converted_pages

        except Exception as e:
            raise VisionParserError(
                f"Failed to convert PDF file into markdown content: {str(e)}"
            )
