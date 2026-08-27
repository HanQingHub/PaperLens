from typing import Optional

from sqlalchemy import Float, ForeignKey, Index, Integer, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from app.core.util import now_iso


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    display_name: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(Text, default=now_iso)


class Session(Base):
    __tablename__ = "sessions"
    token: Mapped[str] = mapped_column(Text, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    expires_at: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(Text, default=now_iso)


class Project(Base):
    __tablename__ = "projects"
    __table_args__ = (Index("ix_projects_user_id", "user_id"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[str] = mapped_column(Text, default=now_iso)


class Paper(Base):
    __tablename__ = "papers"
    __table_args__ = (
        Index("ix_papers_user_id", "user_id"),
        Index("ix_papers_file_type", "file_type"),
    )
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    project_id: Mapped[Optional[int]] = mapped_column(ForeignKey("projects.id", ondelete="SET NULL"))
    title: Mapped[Optional[str]] = mapped_column(Text)
    authors: Mapped[Optional[str]] = mapped_column(Text)
    venue: Mapped[Optional[str]] = mapped_column(Text)
    year: Mapped[Optional[int]] = mapped_column(Integer)
    doi: Mapped[Optional[str]] = mapped_column(Text)
    arxiv_id: Mapped[Optional[str]] = mapped_column(Text)
    file_hash: Mapped[str] = mapped_column(Text, nullable=False)
    file_type: Mapped[str] = mapped_column(Text, nullable=False, default="pdf", server_default="pdf")  # pdf | markdown
    orig_filename: Mapped[Optional[str]] = mapped_column(Text)
    page_count: Mapped[Optional[int]] = mapped_column(Integer)
    open_count: Mapped[int] = mapped_column(Integer, default=0)
    is_scanned: Mapped[int] = mapped_column(Integer, default=0)
    ocr_status: Mapped[str] = mapped_column(Text, default="none")  # none|pending|running|done|failed
    tags: Mapped[Optional[str]] = mapped_column(Text)  # JSON 数组
    note: Mapped[Optional[str]] = mapped_column(Text)
    is_favorite: Mapped[int] = mapped_column(Integer, default=0)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[str] = mapped_column(Text, default=now_iso)
    last_opened_at: Mapped[Optional[str]] = mapped_column(Text)


class OcrDoc(Base):
    __tablename__ = "ocr_docs"
    paper_id: Mapped[int] = mapped_column(
        ForeignKey("papers.id", ondelete="CASCADE"), primary_key=True
    )
    status: Mapped[Optional[str]] = mapped_column(Text)
    engine: Mapped[Optional[str]] = mapped_column(Text)
    started_at: Mapped[Optional[str]] = mapped_column(Text)
    finished_at: Mapped[Optional[str]] = mapped_column(Text)
    pages_done: Mapped[int] = mapped_column(Integer, default=0)
    pages_total: Mapped[Optional[int]] = mapped_column(Integer)
    error: Mapped[Optional[str]] = mapped_column(Text)


class Annotation(Base):
    __tablename__ = "annotations"
    __table_args__ = (Index("ix_annotations_paper_page", "paper_id", "page_no"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    paper_id: Mapped[int] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"), nullable=False)
    page_no: Mapped[int] = mapped_column(Integer, nullable=False)
    type: Mapped[str] = mapped_column(Text)  # word_note | sentence
    anchor_json: Mapped[str] = mapped_column(Text)
    card_json: Mapped[Optional[str]] = mapped_column(Text)
    color: Mapped[Optional[str]] = mapped_column(Text)
    text: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(Text, default=now_iso)
    updated_at: Mapped[str] = mapped_column(Text, default=now_iso)


class Word(Base):
    __tablename__ = "words"
    __table_args__ = (
        UniqueConstraint("user_id", "lemma", name="uq_words_user_lemma"),
        Index("ix_words_user_lemma", "user_id", "lemma"),
    )
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    lemma: Mapped[str] = mapped_column(Text, nullable=False)
    stage: Mapped[int] = mapped_column(Integer, default=0)  # 0陌生/1学习中/2已掌握
    translation: Mapped[Optional[str]] = mapped_column(Text)
    group_name: Mapped[Optional[str]] = mapped_column(Text)  # 生词分组（NULL=未分组）
    ease: Mapped[float] = mapped_column(Float, default=2.5)
    interval_days: Mapped[float] = mapped_column(Float, default=0)
    due_at: Mapped[Optional[str]] = mapped_column(Text)
    review_count: Mapped[int] = mapped_column(Integer, default=0)
    first_seen_at: Mapped[Optional[str]] = mapped_column(Text)
    last_seen_at: Mapped[Optional[str]] = mapped_column(Text)


class WordGroup(Base):
    __tablename__ = "word_groups"
    __table_args__ = (
        UniqueConstraint("user_id", "name", name="uq_word_groups_user_name"),
        Index("ix_word_groups_user", "user_id"),
    )
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[str] = mapped_column(Text, default=now_iso)


class TranslateHistory(Base):
    __tablename__ = "translate_history"
    __table_args__ = (Index("ix_translate_history_user", "user_id", "created_at"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    word: Mapped[str] = mapped_column(Text, nullable=False)
    sentence: Mapped[Optional[str]] = mapped_column(Text)
    mode: Mapped[str] = mapped_column(Text, nullable=False)  # word | dict | sentence
    result: Mapped[str] = mapped_column(Text, nullable=False)  # 翻译结果 JSON
    created_at: Mapped[str] = mapped_column(Text, default=now_iso)


class ReviewLog(Base):
    __tablename__ = "review_logs"
    __table_args__ = (Index("ix_review_logs_word_id", "word_id"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    word_id: Mapped[int] = mapped_column(ForeignKey("words.id", ondelete="CASCADE"), nullable=False)
    reviewed_at: Mapped[str] = mapped_column(Text, nullable=False)
    q: Mapped[int] = mapped_column(Integer, nullable=False)  # 2|3|5
    prev_interval: Mapped[float] = mapped_column(Float, default=0)
    next_interval: Mapped[float] = mapped_column(Float, default=0)


class WordOccurrence(Base):
    __tablename__ = "word_occurrences"
    __table_args__ = (Index("ix_word_occurrences_word", "word_id"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    word_id: Mapped[int] = mapped_column(ForeignKey("words.id", ondelete="CASCADE"), nullable=False)
    paper_id: Mapped[int] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"), nullable=False)
    page_no: Mapped[Optional[int]] = mapped_column(Integer)
    sentence: Mapped[Optional[str]] = mapped_column(Text)
    context: Mapped[Optional[str]] = mapped_column(Text)
    translation: Mapped[Optional[str]] = mapped_column(Text)
    added_at: Mapped[str] = mapped_column(Text, default=now_iso)


class GlossaryTerm(Base):
    __tablename__ = "glossary_terms"
    __table_args__ = (
        UniqueConstraint("paper_id", "term", name="uq_glossary_paper_term"),
        Index("ix_glossary_paper", "paper_id"),
    )
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    paper_id: Mapped[int] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"), nullable=False)
    term: Mapped[str] = mapped_column(Text, nullable=False)
    domain_translation: Mapped[Optional[str]] = mapped_column(Text)
    confidence: Mapped[Optional[float]] = mapped_column(Float)
    source: Mapped[str] = mapped_column(Text, default="tfidf")  # tfidf | user


class TranslationCache(Base):
    __tablename__ = "translation_cache"
    __table_args__ = (
        UniqueConstraint("user_id", "paper_id", "lemma", "engine", name="uq_cache_word"),
        UniqueConstraint("user_id", "paper_id", "sentence_hash", name="uq_cache_sentence"),
    )
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    paper_id: Mapped[int] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"), nullable=False)
    lemma: Mapped[Optional[str]] = mapped_column(Text)
    sentence_hash: Mapped[Optional[str]] = mapped_column(Text)
    engine: Mapped[Optional[str]] = mapped_column(Text)
    result_json: Mapped[str] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(Text, default=now_iso)


class ReadingProgress(Base):
    __tablename__ = "reading_progress"
    paper_id: Mapped[int] = mapped_column(
        ForeignKey("papers.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    page_no: Mapped[int] = mapped_column(Integer, default=1)
    scroll_y: Mapped[float] = mapped_column(Float, default=0)
    updated_at: Mapped[Optional[str]] = mapped_column(Text)


class ReadingSession(Base):
    __tablename__ = "reading_sessions"
    __table_args__ = (Index("ix_reading_sessions_user_start", "user_id", "start_at"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    paper_id: Mapped[int] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"), nullable=False)
    start_at: Mapped[str] = mapped_column(Text, nullable=False)
    end_at: Mapped[Optional[str]] = mapped_column(Text)
    duration_s: Mapped[int] = mapped_column(Integer, default=0)


class Excerpt(Base):
    __tablename__ = "excerpts"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    paper_id: Mapped[int] = mapped_column(ForeignKey("papers.id", ondelete="CASCADE"), nullable=False)
    page_no: Mapped[Optional[int]] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    translation: Mapped[Optional[str]] = mapped_column(Text)
    note: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(Text, default=now_iso)


class AppSetting(Base):
    __tablename__ = "app_settings"
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    key: Mapped[str] = mapped_column(Text, primary_key=True)
    value: Mapped[Optional[str]] = mapped_column(Text)


class FileRef(Base):
    __tablename__ = "file_refs"
    file_hash: Mapped[str] = mapped_column(Text, primary_key=True)
    ref_count: Mapped[int] = mapped_column(Integer, default=0)
