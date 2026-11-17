import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    hasError: false,
    errorMessage: '',
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error?.message || 'Kutilmagan texnik xatolik yuz berdi.',
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Application ErrorBoundary caught:', error, info);
  }

  handleRecover = (): void => {
    this.setState({ hasError: false, errorMessage: '' });
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl bg-white border border-slate-200 shadow-xl p-6 text-center space-y-4">
            <div className="w-14 h-14 mx-auto rounded-2xl bg-amber-50 border border-amber-200 text-amber-700 flex items-center justify-center">
              <AlertTriangle className="w-7 h-7" />
            </div>
            <div className="space-y-1.5">
              <h1 className="font-display font-bold text-xl text-slate-900">
                Tizimni avtomatik tiklash
              </h1>
              <p className="text-xs text-slate-600 leading-relaxed">
                Kutilmagan uzilish yuz berdi. Barcha saqlangan ma’lumotlar bazada xavfsiz turibdi —
                quyidagi tugma orqali platformani darhol qayta ishga tushiring.
              </p>
              {this.state.errorMessage && (
                <p className="text-[11px] font-mono text-slate-400 break-words pt-1">
                  {this.state.errorMessage}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={this.handleRecover}
              className="w-full inline-flex items-center justify-center gap-2 min-h-[46px] px-5 py-2.5 text-sm font-semibold text-white bg-[#0F2942] hover:bg-slate-800 rounded-xl transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              <span>Platformani qayta ishga tushirish</span>
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
